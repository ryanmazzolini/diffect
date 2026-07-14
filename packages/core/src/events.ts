import { mkdirSync, watch, type FSWatcher } from "node:fs";
import type { ServerResponse } from "node:http";
import {
  DAEMON_EVENTS,
  type DaemonEventPayload,
  type DaemonEventType,
  type FeedbackAddedPayload,
  type ThreadEvent,
} from "@diffect/shared";
import { repoStoreDir, spaceStoreDir } from "./store/paths.js";
import {
  readEvents,
  repoThreadStore,
  spaceThreadStore,
  type ThreadStoreRef,
} from "./reviews/event-log.js";
import { workspacePaths } from "./reviews/refresh.js";
import type { Workspace } from "./workspace.js";

export type { DaemonEventType };

/**
 * Watches the workspace's worktrees and `.reviews/` and fans filesystem changes
 * out to connected SSE clients. The daemon owns one hub for its lifetime.
 *
 * Most events stay coarse — "something changed, re-fetch". `feedback.added`
 * identifies only newly appended comments so agent integrations can filter before
 * invoking a model. The file store remains the source of truth.
 */
export class EventHub {
  private clients = new Set<ServerResponse>();
  private feedbackHistory: Array<{ id: string; frame: string }> = [];
  private watchers: FSWatcher[] = [];
  private timers = new Map<string, NodeJS.Timeout>();
  private payloads = new Map<string, DaemonEventPayload>();
  private reviewPositions = new Map<string, number>();
  private reviewScans = new Map<string, Promise<void>>();
  private watchGeneration = 0;
  private started = false;

  constructor(private ws: Workspace) {}

  /** Begin watching. Safe to call once; later calls are no-ops. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.attachWatches();
  }

  /**
   * Swap the watched workspace (e.g. after a workspace is added/removed) without
   * dropping connected SSE clients: tear down the file watchers, re-attach for
   * the new repo set, and notify clients that the workspace list changed.
   */
  async rebuild(ws: Workspace): Promise<void> {
    this.detachWatches();
    this.reviewScans.clear();
    this.ws = ws;
    if (this.started) await this.attachWatches();
    this.emit(DAEMON_EVENTS.workspaceChanged);
  }

  private async attachWatches(): Promise<void> {
    const generation = this.watchGeneration;

    // Review stores: seed each append cursor at the current end before watching.
    // Existing comments are baseline state; only records appended afterwards emit
    // feedback.added. A final scan after attaching closes the read/watch race.
    // A repo can appear in several registered workspaces, but its central store
    // gets one watcher and reports every workspace that contains it.
    const reviewWatches = new Map<
      string,
      {
        dir: string;
        store: ThreadStoreRef;
        workspacePaths: Set<string>;
      }
    >();
    const collectReviewWatch = (
      dir: string,
      store: ThreadStoreRef,
      workspacePath: string,
    ) => {
      const key = reviewStoreKey(store);
      const existing = reviewWatches.get(key);
      if (existing) existing.workspacePaths.add(workspacePath);
      else reviewWatches.set(key, { dir, store, workspacePaths: new Set([workspacePath]) });
    };
    for (const path of workspacePaths(this.ws)) {
      collectReviewWatch(spaceStoreDir(path), spaceThreadStore(path), path);
    }
    for (const repo of this.ws.repos) {
      collectReviewWatch(
        repoStoreDir(repo.root),
        repoThreadStore(repo.root),
        repo.workspacePath ?? this.ws.root,
      );
    }
    for (const key of this.reviewPositions.keys()) {
      if (!reviewWatches.has(key)) this.reviewPositions.delete(key);
    }
    for (const watch of reviewWatches.values()) {
      await this.addReviewWatch(
        watch.dir,
        watch.store,
        [...watch.workspacePaths],
        generation,
      );
    }
    if (generation !== this.watchGeneration) return;

    // Worktrees: a source change may change the diff. Recursive watch covers
    // nested files; git's own writes under .git are filtered out below.
    for (const repo of this.ws.repos) {
      this.addWatch(repo.commonDir, (filename) => {
        if (!isGitStatePath(filename)) return;
        this.emit(DAEMON_EVENTS.diffChanged, { repo: repo.name });
        this.emit(DAEMON_EVENTS.workspaceChanged, { repo: repo.name });
      });
      for (const wt of repo.worktrees) {
        this.addWatch(wt.root, (filename) => {
          if (isIgnoredPath(filename)) return;
          this.emit(DAEMON_EVENTS.diffChanged, {
            repo: repo.name,
            worktree: wt.root === repo.root ? null : wt.name,
            path: normalizeWatchPath(filename),
          });
        });
      }
    }
  }

  private async addReviewWatch(
    dir: string,
    store: ThreadStoreRef,
    workspacePaths: string[],
    generation: number,
  ): Promise<void> {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return;
    }

    const key = reviewStoreKey(store);
    const events = await readEvents(store);
    if (generation !== this.watchGeneration) return;
    const position = this.reviewPositions.get(key);
    if (position === undefined || events.length < position) {
      this.reviewPositions.set(key, events.length);
    }
    this.addWatch(dir, () => {
      if (generation !== this.watchGeneration) return;
      this.emit(DAEMON_EVENTS.threadChanged);
      void this.scanReviewStore(key, store, workspacePaths, generation);
    });
    await this.scanReviewStore(key, store, workspacePaths, generation);
  }

  private scanReviewStore(
    key: string,
    store: ThreadStoreRef,
    workspacePaths: string[],
    generation: number,
  ): Promise<void> {
    const previous = this.reviewScans.get(key) ?? Promise.resolve();
    const scan = previous.then(async () => {
      if (generation !== this.watchGeneration) return;
      const events = await readEvents(store);
      if (generation !== this.watchGeneration) return;

      const position = this.reviewPositions.get(key) ?? events.length;
      if (events.length < position) {
        // The append-only log was replaced or truncated. Treat its current state
        // as a fresh baseline rather than replaying old feedback.
        this.reviewPositions.set(key, events.length);
        return;
      }

      this.reviewPositions.set(key, events.length);
      for (const event of events.slice(position)) {
        const payload = feedbackPayload(event, workspacePaths);
        if (payload) this.emit(DAEMON_EVENTS.feedbackAdded, payload);
      }
    });
    const settled = scan.catch(() => {});
    this.reviewScans.set(key, settled);
    void settled.then(() => {
      if (this.reviewScans.get(key) === settled) this.reviewScans.delete(key);
    });
    return settled;
  }

  private detachWatches(): void {
    this.watchGeneration += 1;
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  private addWatch(dir: string, onChange: (filename: string | null) => void): void {
    try {
      const w = watch(dir, { recursive: true, persistent: false }, (_e, filename) =>
        onChange(typeof filename === "string" ? filename : null),
      );
      w.on("error", () => {}); // a vanished/recreated dir shouldn't crash the daemon
      this.watchers.push(w);
    } catch {
      // Directory may not exist yet (e.g. .reviews/ before the first write).
      // A later write recreates it; the worktree watch still fires diff.changed,
      // and .reviews/ writes also bubble up through the worktree recursive watch.
    }
  }

  /** Register a new SSE client; returns a disposer to call on disconnect. */
  addClient(res: ServerResponse, lastEventId?: string): () => void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n"); // flush headers, defeat proxy buffering
    this.clients.add(res);
    if (lastEventId) {
      const index = this.feedbackHistory.findIndex((entry) => entry.id === lastEventId);
      if (index >= 0) {
        for (const entry of this.feedbackHistory.slice(index + 1)) res.write(entry.frame);
      }
    }
    return () => this.clients.delete(res);
  }

  /**
   * Fan out an event that isn't driven by a filesystem watch. A session
   * archive/revive writes to the thread log (so the fs watch fires
   * `threadChanged`), but the archived-session list rides on the workspace
   * summary, which the client refetches only on `workspaceChanged` — so the
   * route must announce that explicitly. Debounced like watch-driven events.
   */
  notify(type: DaemonEventType, payload: DaemonEventPayload = {}): void {
    this.emit(type, payload);
  }

  /** Debounced fan-out: collapse filesystem bursts per affected repo/worktree. */
  private emit(type: DaemonEventType, payload: DaemonEventPayload = {}): void {
    const key = eventDebounceKey(type, payload);
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const previous = this.payloads.get(key);
    this.payloads.set(key, payload.path || !previous?.path ? payload : previous);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        const data = this.payloads.get(key) ?? {};
        this.payloads.delete(key);
        this.broadcast(type, data);
      }, 120),
    );
  }

  private broadcast(type: DaemonEventType, payload: DaemonEventPayload): void {
    const eventId = type === DAEMON_EVENTS.feedbackAdded ? payload.eventId : undefined;
    const frame = `${eventId ? `id: ${eventId}\n` : ""}event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    if (eventId) {
      this.feedbackHistory.push({ id: eventId, frame });
      if (this.feedbackHistory.length > 256) this.feedbackHistory.shift();
    }
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  /** Stop all watchers and timers. Does not close client connections. */
  close(): void {
    this.detachWatches();
    this.reviewPositions.clear();
    this.reviewScans.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.payloads.clear();
    this.feedbackHistory = [];
  }
}

function reviewStoreKey(store: ThreadStoreRef): string {
  return typeof store === "string" ? `repo:${store}` : `${store.kind}:${store.root}`;
}

function feedbackPayload(
  event: ThreadEvent,
  workspacePaths: string[],
): FeedbackAddedPayload | null {
  if (event.type === "thread.created") {
    return {
      eventId: `thread.created:${event.id}`,
      workspacePaths,
      threadId: event.id,
      source: event.type,
      author: event.author,
    };
  }
  if (event.type === "comment.added") {
    return {
      eventId: `comment.added:${event.commentId}`,
      workspacePaths,
      threadId: event.thread,
      source: event.type,
      author: event.author,
    };
  }
  return null;
}

function eventDebounceKey(type: DaemonEventType, payload: DaemonEventPayload): string {
  if (type === DAEMON_EVENTS.feedbackAdded && payload.eventId) {
    return `${type}\0${payload.eventId}`;
  }
  if (type !== DAEMON_EVENTS.diffChanged || !payload.repo) return type;
  const worktree = "worktree" in payload ? (payload.worktree ?? "") : "*";
  return `${type}\0${payload.repo}\0${worktree}`;
}

/** Paths under the shared git dir that affect labels, refs, or PR links. */
function isGitStatePath(filename: string | null): boolean {
  if (!filename) return true; // unknown file: notify to be safe
  const parts = filename.split(/[/\\]/);
  return (
    parts.at(-1) === "HEAD" ||
    parts[0] === "refs" ||
    filename === "packed-refs"
  );
}

/** Paths under a worktree whose changes should not trigger diff.changed. */
function isIgnoredPath(filename: string | null): boolean {
  if (!filename) return false; // unknown file: notify to be safe
  const parts = filename.split(/[/\\]/);
  return parts.some(
    (p) => p === ".git" || p === ".reviews" || p === "node_modules",
  );
}

function normalizeWatchPath(filename: string | null): string | null {
  if (!filename) return null;
  return filename.split(/[/\\]/).filter(Boolean).join("/");
}
