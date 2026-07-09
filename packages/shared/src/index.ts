// Shared contract types for the Diffect daemon JSON/SSE API, the diffect CLI,
// and the browser SPA. Keeping these in one place stops the three frontends and
// the file store from drifting apart.

/** Current schema version for the threads.jsonl event log. */
export const THREAD_SCHEMA_VERSION = 2 as const;

/**
 * The oldest event-log schema version replay still understands. v1 threads
 * predate scope binding (Slice 1) — they replay into the unscoped/legacy bucket
 * (scope/sessionId null) rather than being dropped. Replay accepts the inclusive
 * range [MIN, CURRENT]; a future version (> CURRENT) is still ignored so a newer
 * writer's events aren't misinterpreted by an older reader.
 */
export const MIN_THREAD_SCHEMA_VERSION = 1 as const;

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

export interface DiffChangedPayload {
  repo?: string;
  worktree?: string | null;
  path?: string | null;
}
export type DaemonEventPayload = DiffChangedPayload;

export type DiffLineType = "context" | "add" | "del";
export type Side = "old" | "new";

export interface DiffLine {
  type: DiffLineType;
  /** 1-based line number on the old side, null for added lines. */
  old: number | null;
  /** 1-based line number on the new side, null for deleted lines. */
  new: number | null;
  text: string;
  /**
   * True when git emitted a `\ No newline at end of file` marker after this line
   * (the file it belongs to has no trailing newline). Preserved so a serialized
   * diff round-trips exactly — without it the renderer reads every EOF line as
   * un-terminated and mismatches real file content.
   */
  noNewline?: boolean;
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
  /** True when this path matches gitignore rules, even if it is already tracked. */
  ignored?: boolean;
  /** Added/removed line counts (the diffstat), tallied as the diff is parsed. */
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface RepoDiff {
  /** Stamped by the daemon/CLI that knows the workspace; absent from the raw
   * git-layer result. */
  repo?: string;
  worktree?: string | null;
  target: string;
  /**
   * The resolved scope + session for this (repo, worktree, target), stamped by
   * the daemon so the client can bind/filter threads to the current session
   * without resolving git refs itself. Absent on the raw git-layer result.
   */
  scope?: ReviewScope;
  sessionId?: string;
  /**
   * Fingerprint of the current point-in-time git state for this (repo, worktree,
   * target) — the live snapshot. The client compares a thread's `snapshotId`
   * against this to mark it as filed in an *earlier iteration*. Absent on the raw
   * git-layer result (stamped by the daemon, which can read git state).
   */
  currentSnapshotId?: string;
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

/**
 * The review scope a thread is filed under: the normalized target plus the
 * base/head a comment belongs to. Persisted on each thread (Slice 1) so a
 * comment binds to the *changeset* it was made against — not just the worktree
 * directory — and stays addressable as commits advance.
 *
 * `baseRef`/`headRef` are *symbolic* (branch names, "HEAD", "index", …) so the
 * derived `sessionId` is stable while commits move; `baseSha` is the resolved
 * commit the anchor's "old" side reads from, which may legitimately be null
 * (e.g. a repo with no commits yet).
 */
export interface ReviewScope {
  /** The raw target spec the thread was filed under (e.g. "work", "main..feat"). */
  target: string;
  kind: ReviewTargetKind;
  /** Symbolic base ref for session identity (stable as commits advance). */
  baseRef: string;
  /** Symbolic head ref for session identity. */
  headRef: string;
  /** Resolved base commit SHA the anchor's "old" side reads from, when one exists. */
  baseSha: string | null;
  /** Branch checked out in the worktree when the thread was filed (display aid). */
  branch: string | null;
}

export interface PullRequestLink {
  number: number;
  url: string;
  title: string | null;
}

export interface WorktreeSummary {
  name: string;
  root: string;
  /**
   * The checkout's current branch (`symbolic-ref --short HEAD`), or null when
   * detached. Surfaced so the UI can label which branch a worktree is on and
   * derive a review session for it.
   */
  branch: string | null;
  /** Open GitHub PR for this branch, when one is cheap to discover. */
  pullRequest: PullRequestLink | null;
}

/**
 * A review session surfaced as a primary sidebar entry: a (repo, checkout,
 * target) resolved into a stable session identity. The whole `scope` is carried
 * so the UI can label the entry (branch / range / local) and re-select it
 * without resolving any git refs itself; `id` equals `sessionIdForScope(scope)`,
 * the join key against `Thread.sessionId`.
 *
 * Server-derived sessions — one `work` session per checked-out worktree — ride
 * on `RepoSummary.sessions`. The client also reconstructs sessions from existing
 * threads' scopes (so a range/staged review you've commented on stays a reachable
 * entry) and from the active diff; all three share this one shape, deduped by `id`.
 */
export interface ReviewSession {
  /** Stable id; equals `sessionIdForScope(scope)` and `Thread.sessionId`. */
  id: string;
  /** The scope this session reviews — its target spec, base/head, and branch. */
  scope: ReviewScope;
  /**
   * Checkout to select with this session: null for the primary worktree, else
   * the URL-safe worktree name. MUST match how `id` was derived (the daemon
   * resolves the primary as worktree=null) so the diff route re-stamps the same id.
   */
  worktree: string | null;
}

/** Branches, tags, remote-tracking branches, and recent commits for the compare picker (GET /repos/:repo/refs). */
export interface RefList {
  branches: string[];
  tags: string[];
  /** Remote-tracking branches by short name (e.g. "origin/main"); excludes each remote's symbolic HEAD alias. */
  remotes: string[];
  commits: { sha: string; subject: string }[];
}

export type RefSearchKind = "branch" | "tag" | "remote" | "commit";

/** One selectable base/compare point returned by `GET /repos/:repo/refs/search`. */
export interface RefSearchOption {
  kind: RefSearchKind;
  /** Value to place in a Review Target Spec. Branches/tags use their names; commits use the full SHA. */
  value: string;
  /** Primary label. For commits this is the short SHA. */
  label: string;
  /** Commit subject, when known. */
  subject?: string;
  /** Full commit SHA for commit results. */
  sha?: string;
}

export interface RefSearchResults {
  query: string;
  branches: RefSearchOption[];
  /** Remote-tracking branches (kind "remote"); value is the short name, e.g. "origin/main". */
  remotes: RefSearchOption[];
  tags: RefSearchOption[];
  commits: RefSearchOption[];
}

/** A slice of a file's lines, for unfolding collapsed diff context (GET /repos/:repo/file). */
export interface FileRange {
  /** 1-based line number of the first returned line. */
  from: number;
  lines: string[];
}

/**
 * Full old/new content for a file under a target — the exact two blobs the diff
 * was computed from (GET /repos/:repo/file/content). Lets the diff renderer show
 * expandable collapsed context and validate without reconstructing the file.
 * A side is `""` when it is legitimately empty (added → old, deleted → new) and
 * `null` when unreadable/binary (the client then falls back to diff-only render).
 */
export interface FileContent {
  old: string | null;
  new: string | null;
}

export interface WriteFileContentRequest {
  content: string;
}

export interface WriteFileContentResponse {
  ok: true;
}

export interface AttachmentResponse {
  /** Daemon-served URL to embed in a comment (e.g. `/attachments/<sha>.png`). */
  url: string;
  /** Original filename (for the markdown alt text), if the client sent one. */
  name: string;
}

export interface RepoFileList {
  /** Repo-relative paths of every tracked file (for the cross-file picker). */
  files: string[];
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface FsListing {
  /** The (realpath-resolved) directory listed. */
  path: string;
  /** Parent directory, or null at the browse root (home). */
  parent: string | null;
  entries: FsEntry[];
}

export interface RecommendedWorkspace {
  /** Absolute repo path to register as a workspace. */
  path: string;
  /** Basename, for display. */
  name: string;
  /** Epoch ms of the most recent agent session in this project. */
  lastActiveAt: number;
  source: "claude-code" | "pi";
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
  /**
   * Auto-derived review sessions — one `work` session per checked-out worktree,
   * deduped by id — surfaced as the sidebar's primary review entries. The client
   * augments these with sessions reconstructed from existing threads' scopes.
   */
  sessions: ReviewSession[];
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

export interface UiReviewSelection {
  worktree: string | null;
  target: string;
  openedAt: number;
}

export interface WebsiteReviewUiState {
  bookmarks?: { url: string; title: string; addedAt: number }[];
  history?: { url: string; title: string; lastVisitedAt: number; visitCount: number }[];
  allowedDomains?: string[];
  urlsBySpace?: Record<string, string>;
}

export interface UiState {
  workspaceRecency: Record<string, number>;
  /** Last explicitly opened review per workspace path, then repo name. */
  reviewRecency: Record<string, Record<string, UiReviewSelection>>;
  websiteReview?: WebsiteReviewUiState;
}

export interface UiStateUpdate {
  workspaceRecency?: Record<string, number>;
  reviewRecency?: Record<string, Record<string, UiReviewSelection>>;
  websiteReview?: WebsiteReviewUiState;
}

/** Body for POST/DELETE /workspaces. */
export interface WorkspaceMutationRequest {
  path: string;
}

export interface OpenRequest {
  repo?: string;
  worktree?: string | null;
  workspacePath?: string;
  file?: string;
  line?: number;
  editor: string;
}

export interface OpenUrlRequest {
  url: string;
}

/** Local, reviewable PR draft packet. This is not a GitHub draft PR object. */
export interface PrDraft {
  workspacePath: string;
  repo: string;
  worktree: string | null;
  branch: string | null;
  title: string;
  body: string;
  updatedAt: string | null;
}

export interface PrDraftUpdateRequest {
  title?: string;
  body?: string;
}

export type Severity = "must-fix" | "suggestion" | "nit" | "question";
// A thread is open or closed. The store records *events* (thread.resolved,
// and legacy thread.dismissed) — status is computed on replay, both folding to
// "closed" — so this rename needs no migration.
export type ThreadStatus = "open" | "closed";
export type AnchorState = "active" | "stale";
export type ThreadTargetLevel = "space" | "repo" | "file";
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
  /** null for space-level comments stored on the review space itself. */
  repo: string | null;
  worktree: string | null;
  /** Present for comments loaded from a review-space store. */
  spacePath?: string | null;
  /** What this review comment is about: the whole space, a repo, or a file/range. */
  targetLevel: ThreadTargetLevel;
  /** null for space/repo-level (non-line-anchored) threads. */
  file: string | null;
  side: Side | null;
  line: number | null;
  endLine: number | null;
  anchor: ThreadAnchor | null;
  severity: Severity | null;
  status: ThreadStatus;
  /** Re-anchoring state computed against the current diff; "active" until Slice 3. */
  anchorState: AnchorState;
  /**
   * The review scope (target + base/head) the thread was filed under, or null
   * for legacy (pre-scope, v1) threads — the unscoped bucket.
   */
  scope: ReviewScope | null;
  /**
   * Stable id of the review session this thread belongs to, derived from the
   * scope's symbolic identity. null for legacy threads.
   */
  sessionId: string | null;
  /**
   * Fingerprint of the point-in-time git state (snapshot) the thread was filed
   * against — which *iteration* of the scope it belongs to. null for threads
   * filed before Slice 3 (and when no snapshot could be computed). Informational
   * only: "outdated" is `anchorState`, not snapshot mismatch.
   */
  snapshotId: string | null;
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
  repo: string | null;
  worktree: string | null;
  targetLevel?: ThreadTargetLevel;
  file: string | null;
  side: Side | null;
  line: number | null;
  endLine: number | null;
  anchor: ThreadAnchor | null;
  severity: Severity | null;
  /** Scope/session the thread was filed under. Absent on legacy (v1) events;
   * a v2 writer always stamps them (null only when no scope could be resolved). */
  scope?: ReviewScope | null;
  sessionId?: string | null;
  /** Snapshot (iteration) the thread was filed against. Absent on pre-Slice-3
   * events; rides as a plain optional field — no schema bump, since an older
   * reader simply ignores it and replay defaults it to null. */
  snapshotId?: string | null;
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

/**
 * Legacy event: dismissal was merged into "resolved". No new code emits this,
 * but replay still recognizes it (folding it to resolved) so old logs load.
 */
export interface ThreadDismissedEvent extends BaseEvent {
  type: "thread.dismissed";
  thread: string;
  author: Author;
  /** Optional dismissal reason, recorded as a trailing comment. */
  reason?: string | null;
}

/** A tombstone hiding a thread from all views; the log stays append-only. */
export interface ThreadDeletedEvent extends BaseEvent {
  type: "thread.deleted";
  thread: string;
  author: Author;
}

/** Legacy event from the removed review archive/revive flow.
 * Readers keep accepting it so old logs replay; it no longer drives any state. */
export interface SessionArchivedEvent extends BaseEvent {
  type: "session.archived";
  sessionId: string;
  scope: ReviewScope;
  /** true = archived, false = revived. */
  archived: boolean;
  author: Author;
  note?: string | null;
}

/** Discriminated union of all event-log records. */
export type ThreadEvent =
  | ThreadCreatedEvent
  | CommentAddedEvent
  | ThreadResolvedEvent
  | ThreadDismissedEvent
  | ThreadDeletedEvent
  | SessionArchivedEvent;

export type ThreadEventType = ThreadEvent["type"];

/** Known event-log record types; used to gate unknown records on replay. */
export const THREAD_EVENT_TYPES: readonly ThreadEventType[] = [
  "thread.created",
  "comment.added",
  "thread.resolved",
  "thread.dismissed",
  "thread.deleted",
  "session.archived",
];

// --- API request payloads --------------------------------------------------

export interface CreateThreadRequest {
  repo?: string | null;
  worktree?: string | null;
  /** Absolute selected review-space root; new space/repo-level comments live here. */
  spacePath?: string | null;
  targetLevel?: ThreadTargetLevel;
  file?: string | null;
  side?: Side | null;
  line?: number | null;
  endLine?: number | null;
  severity?: Severity | null;
  /**
   * The review target spec the comment is filed under (e.g. "work", "staged",
   * "main..feat"). The daemon/CLI resolves it server-side into the authoritative
   * `scope`; the client never resolves git refs itself. Defaults to "work".
   */
  target?: string | null;
  /** Resolved scope; set by the daemon/CLI after resolving `target` — not by the
   * client. Anything a client sends here is overwritten. */
  scope?: ReviewScope | null;
  /** Resolved session id; set alongside `scope` by the daemon/CLI. */
  sessionId?: string | null;
  /** Snapshot (iteration) id; computed and set alongside `scope` by the
   * daemon/CLI, never by the client. */
  snapshotId?: string | null;
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

export interface DeleteThreadRequest {
  author?: Author;
}
