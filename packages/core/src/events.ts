import { watch, type FSWatcher } from "node:fs";
import type { ServerResponse } from "node:http";
import { reviewsDir } from "./reviews/event-log.js";
import type { Workspace } from "./workspace.js";

/** Server-sent event types the browser subscribes to. */
export type DaemonEventType = "diff.changed" | "thread.changed";

/**
 * Watches the workspace's worktrees and `.reviews/` and fans filesystem changes
 * out to connected SSE clients. The daemon owns one hub for its lifetime.
 *
 * Events are intentionally coarse — "something changed, re-fetch" — not payloads.
 * The browser already knows how to load diffs and threads; this just tells it
 * when. That keeps the daemon a thin notifier over the file store, which remains
 * the source of truth.
 */
export class EventHub {
  private clients = new Set<ServerResponse>();
  private watchers: FSWatcher[] = [];
  private timers = new Map<DaemonEventType, NodeJS.Timeout>();
  private started = false;

  constructor(private readonly ws: Workspace) {}

  /** Begin watching. Safe to call once; later calls are no-ops. */
  start(): void {
    if (this.started) return;
    this.started = true;

    // Review store: any write under .reviews/ means threads changed.
    this.addWatch(reviewsDir(this.ws.root), () => this.emit("thread.changed"));

    // Worktrees: a source change may change the diff. Recursive watch covers
    // nested files; git's own writes under .git are filtered out below.
    for (const repo of this.ws.repos) {
      for (const wt of repo.worktrees) {
        this.addWatch(wt.root, (filename) => {
          if (isIgnoredPath(filename)) return;
          this.emit("diff.changed");
        });
      }
    }
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
  addClient(res: ServerResponse): () => void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n"); // flush headers, defeat proxy buffering
    this.clients.add(res);
    return () => this.clients.delete(res);
  }

  /** Debounced fan-out: collapse a burst of fs events into one notification. */
  private emit(type: DaemonEventType): void {
    const existing = this.timers.get(type);
    if (existing) clearTimeout(existing);
    this.timers.set(
      type,
      setTimeout(() => {
        this.timers.delete(type);
        this.broadcast(type);
      }, 120),
    );
  }

  private broadcast(type: DaemonEventType): void {
    const frame = `event: ${type}\ndata: {}\n\n`;
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
    for (const w of this.watchers) w.close();
    this.watchers = [];
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

/** Paths under a worktree whose changes should not trigger diff.changed. */
function isIgnoredPath(filename: string | null): boolean {
  if (!filename) return false; // unknown file: notify to be safe
  const parts = filename.split(/[/\\]/);
  return parts.some(
    (p) => p === ".git" || p === ".reviews" || p === "node_modules",
  );
}
