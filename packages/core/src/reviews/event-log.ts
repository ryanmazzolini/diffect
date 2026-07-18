import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  MIN_THREAD_SCHEMA_VERSION,
  THREAD_EVENT_TYPES,
  THREAD_SCHEMA_VERSION,
  type AddCommentRequest,
  type Author,
  type CreateThreadRequest,
  type DeleteThreadRequest,
  type ResolveThreadRequest,
  type Thread,
  type ThreadCreatedEvent,
  type ThreadEvent,
} from "@diffect/shared";
import { genId } from "./ids.js";
import {
  spaceThreadsLogPath,
  threadsLogPath as repoThreadsLogPath,
} from "../store/paths.js";
import { migrateLegacyStore } from "../store/migrate.js";
import { sessionIdForScope } from "./scope.js";

// The canonical review store now lives in a central per-user location keyed by
// repo root (see ../store/paths.ts), not in an in-tree `.reviews/`.
export type ThreadStoreRef =
  | string
  | { kind: "repo" | "space"; root: string };

export function repoThreadStore(root: string): ThreadStoreRef {
  return { kind: "repo", root };
}

export function spaceThreadStore(root: string): ThreadStoreRef {
  return { kind: "space", root };
}

function storeRoot(store: ThreadStoreRef): string {
  return typeof store === "string" ? store : store.root;
}

function isSpaceStore(store: ThreadStoreRef): boolean {
  return typeof store !== "string" && store.kind === "space";
}

function logPath(store: ThreadStoreRef): string {
  return isSpaceStore(store)
    ? spaceThreadsLogPath(storeRoot(store))
    : repoThreadsLogPath(storeRoot(store));
}

/** Raised when an event targets a thread that does not exist. */
export class UnknownThreadError extends Error {
  constructor(public readonly threadId: string) {
    super(`unknown thread: ${threadId}`);
    this.name = "UnknownThreadError";
  }
}

/**
 * Append a `thread.created` event and return the resulting thread. Creates the
 * repo's central log on first write. The file is the source of truth, so this
 * works whether or not the daemon is running.
 */
export async function createThread(
  store: ThreadStoreRef,
  req: CreateThreadRequest,
  now: string,
): Promise<Thread> {
  const event: ThreadCreatedEvent = {
    v: THREAD_SCHEMA_VERSION,
    type: "thread.created",
    id: genId("th"),
    ts: now,
    repo: req.repo ?? null,
    worktree: req.worktree ?? null,
    targetLevel: req.file ? "file" : req.targetLevel === "space" ? "space" : "repo",
    file: req.file ?? null,
    side: req.side ?? null,
    line: req.line ?? null,
    endLine: req.endLine ?? null,
    anchor: req.anchor ?? null,
    severity: req.severity ?? null,
    // Bind sessionId to scope at the store boundary. Scoped writes always carry
    // the canonical checkout-aware id; an unscoped id would be invisible in both
    // session and legacy views, so discard it.
    scope: req.scope ?? null,
    sessionId: req.scope
      ? sessionIdForScope(req.scope, req.worktree ?? null)
      : null,
    // The snapshot is meaningful only within a scope, so bind it the same way:
    // no scope ⇒ no snapshot (a snapshot id with no scope is invisible everywhere).
    snapshotId: req.scope ? (req.snapshotId ?? null) : null,
    author: req.author ?? { type: "user" },
    body: req.body,
  };
  await appendEvent(store, event);
  return requireThread(replay([event]), event.id);
}

/** Append a reply to an existing thread and return the updated thread. */
export async function addComment(
  store: ThreadStoreRef,
  threadId: string,
  req: AddCommentRequest,
  now: string,
): Promise<Thread> {
  const events = await readEvents(store);
  requireThread(replay(events), threadId); // validate existence before writing
  const event: ThreadEvent = {
    v: THREAD_SCHEMA_VERSION,
    type: "comment.added",
    ts: now,
    thread: threadId,
    commentId: genId("c"),
    author: req.author ?? { type: "user" },
    body: req.body,
  };
  await appendEvent(store, event);
  return requireThread(replay([...events, event]), threadId);
}

export async function resolveThread(
  store: ThreadStoreRef,
  threadId: string,
  req: ResolveThreadRequest,
  now: string,
): Promise<Thread> {
  const events = await readEvents(store);
  requireThread(replay(events), threadId);
  const event: ThreadEvent = {
    v: THREAD_SCHEMA_VERSION,
    type: "thread.resolved",
    ts: now,
    thread: threadId,
    author: req.author ?? { type: "user" },
    summary: req.summary ?? null,
  };
  await appendEvent(store, event);
  return requireThread(replay([...events, event]), threadId);
}

/**
 * Append a `thread.deleted` tombstone. The thread vanishes from every view on
 * replay, but the log is never rewritten — deletion is just another event.
 */
export async function deleteThread(
  store: ThreadStoreRef,
  threadId: string,
  req: DeleteThreadRequest,
  now: string,
): Promise<void> {
  const events = await readEvents(store);
  // Existence check only (404 if already gone/unknown). Restricting deletion to
  // non-open threads is a UI affordance (like resolve/dismiss), not enforced here.
  requireThread(replay(events), threadId);
  await appendEvent(store, {
    v: THREAD_SCHEMA_VERSION,
    type: "thread.deleted",
    ts: now,
    thread: threadId,
    author: req.author ?? { type: "user" },
  });
}

async function appendEvent(
  store: ThreadStoreRef,
  event: ThreadEvent,
): Promise<void> {
  // Fold a legacy in-tree repo store into the central log before the first write
  // so appends never split history across two locations. Space stores are new and
  // have no legacy in-tree location.
  if (!isSpaceStore(store)) await migrateLegacyStore(storeRoot(store));
  const path = logPath(store);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(event) + "\n", "utf8");
}

/**
 * Read the raw log text, folding in a legacy in-tree repo store on a first miss.
 * Returns null when no log exists yet (so the store simply has no threads).
 */
async function readLogRaw(store: ThreadStoreRef): Promise<string | null> {
  try {
    return await readFile(logPath(store), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (isSpaceStore(store)) return null;
  // A missing central log may predate migration; attempt it once, then re-read.
  await migrateLegacyStore(storeRoot(store));
  try {
    return await readFile(logPath(store), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Read and parse every event from the log, skipping blank/corrupt lines. */
export async function readEvents(store: ThreadStoreRef): Promise<ThreadEvent[]> {
  const raw = await readLogRaw(store);
  if (raw === null) return [];
  const events: ThreadEvent[] = [];
  const lines = raw.split("\n");
  // The last non-empty line is the only place a partial write can land (a crash
  // mid-append). A corrupt line before it is real corruption worth surfacing,
  // not silently dropping a thread.
  let lastNonEmpty = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim()) {
      lastNonEmpty = i;
      break;
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    const parsed = parseEvent(trimmed);
    if (parsed) {
      events.push(parsed);
    } else if (i !== lastNonEmpty) {
      process.stderr.write(
        `diffect: skipping unparseable event at ${logPath(store)}:${i + 1}\n`,
      );
    }
  }
  return events;
}

function parseEvent(line: string): ThreadEvent | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null; // tolerate a partially-written final line
  }
  if (!obj || typeof obj !== "object") return null;
  const e = obj as { type?: unknown; v?: unknown };
  // Schema-version gate: accept the known range [MIN, CURRENT] so older events
  // (e.g. v1 threads predating scope binding) still replay, but ignore events
  // from a future/unknown schema rather than misinterpreting them.
  if (
    typeof e.v !== "number" ||
    e.v < MIN_THREAD_SCHEMA_VERSION ||
    e.v > THREAD_SCHEMA_VERSION
  )
    return null;
  if (typeof e.type !== "string") return null;
  if (!THREAD_EVENT_TYPES.includes(e.type as ThreadEvent["type"])) return null;
  return obj as ThreadEvent;
}

/** Load all threads by replaying the event log. */
export async function loadThreads(store: ThreadStoreRef): Promise<Thread[]> {
  return replay(await readEvents(store));
}

/**
 * Deterministically reconstruct threads from an event stream. Two passes so the
 * log stays merge-friendly: all `thread.created` events are applied first, then
 * mutations — a `comment.added`/`resolved`/`dismissed` that happens to sit
 * before its `thread.created` (e.g. after a git merge reorders lines) is still
 * applied rather than dropped. Mutations for a genuinely-absent thread are
 * ignored, so a truncated/partial log still replays.
 */
export function replay(events: ThreadEvent[]): Thread[] {
  const byId = new Map<string, Thread>();

  // Pass 1: create every thread.
  for (const e of events) {
    if (e.type !== "thread.created") continue;
    byId.set(e.id, {
      id: e.id,
      repo: e.repo,
      worktree: e.worktree,
      targetLevel: e.file ? "file" : e.targetLevel === "space" ? "space" : "repo",
      file: e.file,
      side: e.side,
      line: e.line,
      endLine: e.endLine,
      anchor: e.anchor,
      severity: e.severity,
      status: "open",
      anchorState: "active",
      // Legacy (v1) created events carry no scope/session — default to the
      // unscoped bucket rather than dropping the thread (ADR migration rule).
      // Scoped old/new events are projected to one canonical checkout-aware id;
      // the stored id remains untouched in the append-only source log and is
      // accepted separately as a legacy lookup alias.
      scope: e.scope ?? null,
      sessionId: e.scope
        ? sessionIdForScope(e.scope, e.worktree ?? null)
        : null,
      // Pre-Slice-3 (and unscoped) events carry no snapshot — default to null,
      // bound to scope exactly like sessionId so an orphaned id can't survive.
      snapshotId: e.scope ? (e.snapshotId ?? null) : null,
      comments: [
        { id: genCommentId(e.id, 0), author: e.author, body: e.body, ts: e.ts },
      ],
      createdAt: e.ts,
      updatedAt: e.ts,
    });
  }

  // Pass 2: apply comments and status changes in log order.
  for (const e of events) {
    // thread.created is handled in pass 1; legacy session.archived events never
    // touched threads, so both skip the thread-mutation switch below.
    if (e.type === "thread.created" || e.type === "session.archived") continue;
    const t = byId.get(e.thread);
    if (!t) continue;
    switch (e.type) {
      case "comment.added":
        t.comments.push({ id: e.commentId, author: e.author, body: e.body, ts: e.ts });
        break;
      case "thread.resolved":
        t.status = "closed";
        appendStatusNote(t, e.author, e.summary, e.ts);
        break;
      case "thread.dismissed":
        // Legacy: dismissal merged into closing. Fold to closed, keeping the
        // recorded reason as the trailing note so old logs read sensibly.
        t.status = "closed";
        appendStatusNote(t, e.author, e.reason, e.ts);
        break;
      case "thread.deleted":
        // Tombstone: drop the thread entirely so it never surfaces again.
        byId.delete(e.thread);
        continue;
    }
    // updatedAt tracks the latest event time, never moving backward.
    if (e.ts > t.updatedAt) t.updatedAt = e.ts;
  }
  return [...byId.values()];
}

/**
 * Record an optional resolve/dismiss note as a trailing comment so the reason is
 * never lost — a status change without explanation is an anti-pattern.
 */
function appendStatusNote(
  thread: Thread,
  author: Author,
  note: string | null | undefined,
  ts: string,
): void {
  if (!note || !note.trim()) return;
  thread.comments.push({
    id: genCommentId(thread.id, thread.comments.length),
    author,
    body: note.trim(),
    ts,
  });
}

function requireThread(threads: Thread[], id: string): Thread {
  const t = threads.find((x) => x.id === id);
  if (!t) throw new UnknownThreadError(id);
  return t;
}

function genCommentId(threadId: string, index: number): string {
  return `${threadId}#${index}`;
}
