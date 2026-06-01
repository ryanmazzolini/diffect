import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  THREAD_EVENT_TYPES,
  THREAD_SCHEMA_VERSION,
  type AddCommentRequest,
  type Author,
  type CreateThreadRequest,
  type DismissThreadRequest,
  type ResolveThreadRequest,
  type Thread,
  type ThreadCreatedEvent,
  type ThreadEvent,
} from "@diffect/shared";
import { genId } from "./ids.js";

/** Location of the canonical review store inside a workspace. */
export function reviewsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".reviews");
}

export function threadsLogPath(workspaceRoot: string): string {
  return join(reviewsDir(workspaceRoot), "threads.jsonl");
}

/** Raised when an event targets a thread that does not exist. */
export class UnknownThreadError extends Error {
  constructor(public readonly threadId: string) {
    super(`unknown thread: ${threadId}`);
    this.name = "UnknownThreadError";
  }
}

/**
 * Append a `thread.created` event and return the resulting thread. Creates
 * `.reviews/threads.jsonl` on first write. The file is the source of truth, so
 * this works whether or not the daemon is running.
 */
export async function createThread(
  workspaceRoot: string,
  req: CreateThreadRequest,
  now: string,
): Promise<Thread> {
  const event: ThreadCreatedEvent = {
    v: THREAD_SCHEMA_VERSION,
    type: "thread.created",
    id: genId("th"),
    ts: now,
    repo: req.repo,
    worktree: req.worktree ?? null,
    file: req.file ?? null,
    side: req.side ?? null,
    line: req.line ?? null,
    endLine: req.endLine ?? null,
    anchor: req.anchor ?? null,
    severity: req.severity ?? null,
    author: req.author ?? { type: "user" },
    body: req.body,
  };
  await appendEvent(workspaceRoot, event);
  return requireThread(replay([event]), event.id);
}

/** Append a reply to an existing thread and return the updated thread. */
export async function addComment(
  workspaceRoot: string,
  threadId: string,
  req: AddCommentRequest,
  now: string,
): Promise<Thread> {
  const events = await readEvents(workspaceRoot);
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
  await appendEvent(workspaceRoot, event);
  return requireThread(replay([...events, event]), threadId);
}

export async function resolveThread(
  workspaceRoot: string,
  threadId: string,
  req: ResolveThreadRequest,
  now: string,
): Promise<Thread> {
  const events = await readEvents(workspaceRoot);
  requireThread(replay(events), threadId);
  const event: ThreadEvent = {
    v: THREAD_SCHEMA_VERSION,
    type: "thread.resolved",
    ts: now,
    thread: threadId,
    author: req.author ?? { type: "user" },
    summary: req.summary ?? null,
  };
  await appendEvent(workspaceRoot, event);
  return requireThread(replay([...events, event]), threadId);
}

export async function dismissThread(
  workspaceRoot: string,
  threadId: string,
  req: DismissThreadRequest,
  now: string,
): Promise<Thread> {
  const events = await readEvents(workspaceRoot);
  requireThread(replay(events), threadId);
  const event: ThreadEvent = {
    v: THREAD_SCHEMA_VERSION,
    type: "thread.dismissed",
    ts: now,
    thread: threadId,
    author: req.author ?? { type: "user" },
    reason: req.reason ?? null,
  };
  await appendEvent(workspaceRoot, event);
  return requireThread(replay([...events, event]), threadId);
}

async function appendEvent(
  workspaceRoot: string,
  event: ThreadEvent,
): Promise<void> {
  const path = threadsLogPath(workspaceRoot);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(event) + "\n", "utf8");
}

/** Read and parse every event from the log, skipping blank/corrupt lines. */
export async function readEvents(workspaceRoot: string): Promise<ThreadEvent[]> {
  let raw: string;
  try {
    raw = await readFile(threadsLogPath(workspaceRoot), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
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
        `diffect: skipping unparseable event at ${threadsLogPath(workspaceRoot)}:${i + 1}\n`,
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
  // Schema-version gate: ignore events from a future/unknown schema rather than
  // misinterpreting them.
  if (e.v !== THREAD_SCHEMA_VERSION) return null;
  if (typeof e.type !== "string") return null;
  if (!THREAD_EVENT_TYPES.includes(e.type as ThreadEvent["type"])) return null;
  return obj as ThreadEvent;
}

/** Load all threads by replaying the event log. */
export async function loadThreads(workspaceRoot: string): Promise<Thread[]> {
  return replay(await readEvents(workspaceRoot));
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
      file: e.file,
      side: e.side,
      line: e.line,
      endLine: e.endLine,
      anchor: e.anchor,
      severity: e.severity,
      status: "open",
      anchorState: "active",
      comments: [
        { id: genCommentId(e.id, 0), author: e.author, body: e.body, ts: e.ts },
      ],
      createdAt: e.ts,
      updatedAt: e.ts,
    });
  }

  // Pass 2: apply comments and status changes in log order.
  for (const e of events) {
    if (e.type === "thread.created") continue;
    const t = byId.get(e.thread);
    if (!t) continue;
    switch (e.type) {
      case "comment.added":
        t.comments.push({ id: e.commentId, author: e.author, body: e.body, ts: e.ts });
        break;
      case "thread.resolved":
        t.status = "resolved";
        appendStatusNote(t, e.author, e.summary, e.ts);
        break;
      case "thread.dismissed":
        t.status = "dismissed";
        appendStatusNote(t, e.author, e.reason, e.ts);
        break;
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
