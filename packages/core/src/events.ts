import { watch, type FSWatcher } from "node:fs";
import type { ServerResponse } from "node:http";
import {
  DAEMON_EVENTS,
  type DaemonEventPayload,
  type DaemonEventType,
} from "@diffect/shared";
import type { Workspace } from "./workspace.js";

/** Git/worktree-only SSE stream. It has no feedback-store dependency. */
export class GitChangeStream {
  private clients = new Set<ServerResponse>();
  private watchers: FSWatcher[] = [];
  private timers = new Map<string, NodeJS.Timeout>();
  private payloads = new Map<string, DaemonEventPayload>();
  private started = false;

  constructor(private workspace: Workspace) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.attachWatches();
  }

  rebuild(workspace: Workspace): void {
    this.detachWatches();
    this.workspace = workspace;
    if (this.started) this.attachWatches();
    this.emit(DAEMON_EVENTS.workspaceChanged);
  }

  private attachWatches(): void {
    for (const repo of this.workspace.repos) {
      this.addWatch(repo.commonDir, (filename) => {
        if (!isGitStatePath(filename)) return;
        this.emit(DAEMON_EVENTS.diffChanged, { repo: repo.name });
        this.emit(DAEMON_EVENTS.workspaceChanged, { repo: repo.name });
      });
      for (const worktree of repo.worktrees) {
        this.addWatch(worktree.root, (filename) => {
          if (isIgnoredPath(filename)) return;
          this.emit(DAEMON_EVENTS.diffChanged, {
            repo: repo.name,
            worktree: worktree.root === repo.root ? null : worktree.name,
            path: normalizeWatchPath(filename),
          });
        });
      }
    }
  }

  private addWatch(dir: string, onChange: (filename: string | null) => void): void {
    try {
      const watcher = watch(
        dir,
        { recursive: true, persistent: false },
        (_event, filename) =>
          onChange(typeof filename === "string" ? filename : null),
      );
      watcher.on("error", () => {});
      this.watchers.push(watcher);
    } catch {
      // A vanished worktree should not bring down exact Review reads.
    }
  }

  addClient(res: ServerResponse): () => void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    this.clients.add(res);
    return () => this.clients.delete(res);
  }

  private emit(type: DaemonEventType, payload: DaemonEventPayload = {}): void {
    const key = `${type}\0${payload.repo ?? ""}\0${payload.worktree ?? ""}`;
    const previousTimer = this.timers.get(key);
    if (previousTimer) clearTimeout(previousTimer);
    const previousPayload = this.payloads.get(key);
    this.payloads.set(
      key,
      payload.path || !previousPayload?.path ? payload : previousPayload,
    );
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        const current = this.payloads.get(key) ?? {};
        this.payloads.delete(key);
        const frame = `event: ${type}\ndata: ${JSON.stringify(current)}\n\n`;
        for (const client of this.clients) {
          try {
            client.write(frame);
          } catch {
            this.clients.delete(client);
          }
        }
      }, 120),
    );
  }

  private detachWatches(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  close(): void {
    this.detachWatches();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.payloads.clear();
    this.clients.clear();
  }
}

function isGitStatePath(filename: string | null): boolean {
  if (!filename) return true;
  const parts = filename.split(/[/\\]/);
  return (
    parts.at(-1) === "HEAD" ||
    parts[0] === "refs" ||
    filename === "packed-refs"
  );
}

function isIgnoredPath(filename: string | null): boolean {
  if (!filename) return false;
  const parts = filename.split(/[/\\]/);
  return parts.some(
    (part) => part === ".git" || part === ".reviews" || part === "node_modules",
  );
}

function normalizeWatchPath(filename: string | null): string | null {
  if (!filename) return null;
  return filename.split(/[/\\]/).filter(Boolean).join("/");
}
