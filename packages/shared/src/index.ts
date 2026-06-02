// Shared contract types for the Diffect daemon JSON/SSE API, the diffect CLI,
// and the browser SPA. Keeping these in one place stops the three frontends and
// the file store from drifting apart.

/** Current schema version for the threads.jsonl event log. */
export const THREAD_SCHEMA_VERSION = 1 as const;

/**
 * Server-sent event types the daemon broadcasts over `GET /events` and the
 * browser subscribes to. Shared so a rename can't silently break the live
 * connection between daemon and SPA.
 */
export const DAEMON_EVENTS = {
  diffChanged: "diff.changed",
  threadChanged: "thread.changed",
  workspaceChanged: "workspace.changed",
} as const;
export type DaemonEventType = (typeof DAEMON_EVENTS)[keyof typeof DAEMON_EVENTS];

export type DiffLineType = "context" | "add" | "del";
export type Side = "old" | "new";

export interface DiffLine {
  type: DiffLineType;
  /** 1-based line number on the old side, null for added lines. */
  old: number | null;
  /** 1-based line number on the new side, null for deleted lines. */
  new: number | null;
  text: string;
}

export interface DiffHunk {
  /** The raw `@@ -a,b +c,d @@` header. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked";

export interface DiffFile {
  /** Repo-relative path (the new path for renames). */
  path: string;
  /** Previous path for renames. */
  oldPath?: string;
  status: FileStatus;
  hunks: DiffHunk[];
}

export interface RepoDiff {
  /** Stamped by the daemon/CLI that knows the workspace; absent from the raw
   * git-layer result. */
  repo?: string;
  worktree?: string | null;
  target: string;
  files: DiffFile[];
}

/**
 * A normalized review target. The user types a spec (`work`, `staged`, `main`,
 * `main..feature`, …); it resolves to exactly one of these shapes.
 */
export type ReviewTargetKind =
  | "work" // committed-since-base + unstaged + untracked
  | "staged" // index vs HEAD
  | "unstaged" // worktree vs index
  | "ref" // <ref> vs worktree
  | "range"; // <a>..<b> commit range

export interface ReviewTarget {
  /** The original user-facing spec, echoed back for display. */
  spec: string;
  kind: ReviewTargetKind;
  /** For "ref": the single ref. For "range": the left side. */
  from?: string;
  /** For "range": the right side. */
  to?: string;
  /** For "range": true if the spec used three-dot (symmetric) syntax. */
  threeDot?: boolean;
}

export interface WorktreeSummary {
  name: string;
  root: string;
}

export interface RepoSummary {
  /** URL-safe repo id, stable across worktrees. */
  name: string;
  /** Absolute path on the host (primary worktree). */
  root: string;
  /** Resolved base ref the work target diffs against. */
  base: string | null;
  defaultBranch: string | null;
  /** Checkouts of this repo; length > 1 is an A/B group. */
  worktrees: WorktreeSummary[];
}

export interface WorkspaceInfo {
  root: string;
  repos: RepoSummary[];
  openThreadCount: number;
  /** Editors detected on the host, for the open-in-editor handoff. */
  editors: string[];
}

/** One registered workspace path and the repos discovered under it. */
export interface WorkspaceEntry {
  /** Absolute path the workspace was registered at. */
  path: string;
  repos: RepoSummary[];
}

/** Body for POST/DELETE /workspaces. */
export interface WorkspaceMutationRequest {
  path: string;
}

export interface OpenRequest {
  repo: string;
  worktree?: string | null;
  file: string;
  line: number;
  editor: string;
}

export type Severity = "must-fix" | "suggestion" | "nit" | "question";
export type ThreadStatus = "open" | "resolved" | "dismissed";
export type AnchorState = "active" | "stale";
export type AuthorType = "user" | "agent";

export interface Author {
  type: AuthorType;
  name?: string;
}

export interface Comment {
  id: string;
  author: Author;
  body: string;
  ts: string;
}

export interface ThreadAnchor {
  baseSha: string | null;
  /** Hash of the selected commented range. */
  anchorHash: string | null;
  /** Hash of N lines of surrounding context. */
  contextHash: string | null;
  /** Hash of the whole reviewed file content (staleness signal, not invalidation). */
  fileHash: string | null;
  /** A snippet of the anchored hunk for re-anchoring after edits. */
  hunkSnippet: string | null;
}

/** A thread after replaying the event log. */
export interface Thread {
  id: string;
  repo: string;
  worktree: string | null;
  /** null for general (non-line-anchored) threads. */
  file: string | null;
  side: Side | null;
  line: number | null;
  endLine: number | null;
  anchor: ThreadAnchor | null;
  severity: Severity | null;
  status: ThreadStatus;
  /** Re-anchoring state computed against the current diff; "active" until Slice 3. */
  anchorState: AnchorState;
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
}

// --- Event log -------------------------------------------------------------

interface BaseEvent {
  v: typeof THREAD_SCHEMA_VERSION;
  ts: string;
}

export interface ThreadCreatedEvent extends BaseEvent {
  type: "thread.created";
  id: string;
  repo: string;
  worktree: string | null;
  file: string | null;
  side: Side | null;
  line: number | null;
  endLine: number | null;
  anchor: ThreadAnchor | null;
  severity: Severity | null;
  author: Author;
  body: string;
}

/** A reply added to an existing thread (human or agent). */
export interface CommentAddedEvent extends BaseEvent {
  type: "comment.added";
  /** Target thread id. */
  thread: string;
  /** Stable comment id, unique within the thread. */
  commentId: string;
  author: Author;
  body: string;
}

export interface ThreadResolvedEvent extends BaseEvent {
  type: "thread.resolved";
  thread: string;
  author: Author;
  /** Optional resolution note, recorded as a trailing comment. */
  summary?: string | null;
}

export interface ThreadDismissedEvent extends BaseEvent {
  type: "thread.dismissed";
  thread: string;
  author: Author;
  /** Optional dismissal reason, recorded as a trailing comment. */
  reason?: string | null;
}

/** Discriminated union of all event-log records. */
export type ThreadEvent =
  | ThreadCreatedEvent
  | CommentAddedEvent
  | ThreadResolvedEvent
  | ThreadDismissedEvent;

export type ThreadEventType = ThreadEvent["type"];

/** Known event-log record types; used to gate unknown records on replay. */
export const THREAD_EVENT_TYPES: readonly ThreadEventType[] = [
  "thread.created",
  "comment.added",
  "thread.resolved",
  "thread.dismissed",
];

// --- API request payloads --------------------------------------------------

export interface CreateThreadRequest {
  repo: string;
  worktree?: string | null;
  file?: string | null;
  side?: Side | null;
  line?: number | null;
  endLine?: number | null;
  severity?: Severity | null;
  /** Precomputed durable anchor; the daemon/CLI fills this from file content. */
  anchor?: ThreadAnchor | null;
  author?: Author;
  body: string;
}

export interface AddCommentRequest {
  author?: Author;
  body: string;
}

export interface ResolveThreadRequest {
  author?: Author;
  summary?: string | null;
}

export interface DismissThreadRequest {
  author?: Author;
  reason?: string | null;
}
