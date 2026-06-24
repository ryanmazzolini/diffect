import { DAEMON_EVENTS } from "@diffect/shared";
import type {
  AddCommentRequest,
  ArchiveSessionRequest,
  ArchivedSession,
  AttachmentResponse,
  CreateThreadRequest,
  DaemonEventType,
  FileContent,
  FileRange,
  FsListing,
  OpenRequest,
  OpenUrlRequest,
  RecommendedWorkspace,
  RefList,
  RefSearchResults,
  RepoDiff,
  RepoFileList,
  ResolveThreadRequest,
  Thread,
  WorkspaceEntry,
  WorkspaceInfo,
} from "@diffect/shared";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).error ?? "";
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  workspace: () => fetch("/workspace").then((r) => json<WorkspaceInfo>(r)),

  workspaces: () => fetch("/workspaces").then((r) => json<WorkspaceEntry[]>(r)),

  addWorkspace: (path: string) =>
    fetch("/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    }).then((r) => json<WorkspaceEntry[]>(r)),

  fsList: (path?: string) => {
    const qs = path ? `?path=${encodeURIComponent(path)}` : "";
    return fetch(`/fs/list${qs}`).then((r) => json<FsListing>(r));
  },

  recommendations: () =>
    fetch("/recommendations").then((r) => json<RecommendedWorkspace[]>(r)),

  repoFiles: (repo: string, worktree?: string | null) => {
    const qs = worktree ? `?worktree=${encodeURIComponent(worktree)}` : "";
    return fetch(`/repos/${encodeURIComponent(repo)}/files${qs}`).then((r) =>
      json<RepoFileList>(r),
    );
  },

  uploadAttachment: (file: File) =>
    fetch("/attachments", {
      method: "POST",
      headers: {
        "content-type": file.type || "application/octet-stream",
        // Percent-encode so a non-ASCII filename is a valid header value.
        "x-filename": encodeURIComponent(file.name),
      },
      body: file,
    }).then((r) => json<AttachmentResponse>(r)),

  diff: (repo: string, opts: { worktree?: string | null; target?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.worktree) q.set("worktree", opts.worktree);
    if (opts.target) q.set("target", opts.target);
    const qs = q.toString();
    return fetch(
      `/repos/${encodeURIComponent(repo)}/diff${qs ? `?${qs}` : ""}`,
    ).then((r) => json<RepoDiff>(r));
  },

  file: (
    repo: string,
    opts: { path: string; side: string; from: number; to: number; worktree?: string | null },
  ) => {
    const q = new URLSearchParams({
      path: opts.path,
      side: opts.side,
      from: String(opts.from),
      to: String(opts.to),
    });
    if (opts.worktree) q.set("worktree", opts.worktree);
    return fetch(`/repos/${encodeURIComponent(repo)}/file?${q}`).then((r) =>
      json<FileRange>(r),
    );
  },

  /** Full old/new content for a file under a target — lets the diff renderer show
   *  expandable context and validate without reconstructing the file. */
  fileContent: (
    repo: string,
    opts: { path: string; oldPath?: string | null; target?: string; worktree?: string | null },
  ) => {
    const q = new URLSearchParams({ path: opts.path });
    if (opts.oldPath && opts.oldPath !== opts.path) q.set("oldPath", opts.oldPath);
    if (opts.target) q.set("target", opts.target);
    if (opts.worktree) q.set("worktree", opts.worktree);
    return fetch(`/repos/${encodeURIComponent(repo)}/file/content?${q}`).then((r) =>
      json<FileContent>(r),
    );
  },

  refs: (repo: string, worktree?: string | null) => {
    const q = new URLSearchParams();
    if (worktree) q.set("worktree", worktree);
    const qs = q.toString();
    return fetch(
      `/repos/${encodeURIComponent(repo)}/refs${qs ? `?${qs}` : ""}`,
    ).then((r) => json<RefList>(r));
  },

  searchRefs: (
    repo: string,
    opts: { query?: string; limit?: number; worktree?: string | null } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.query) q.set("q", opts.query);
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.worktree) q.set("worktree", opts.worktree);
    const qs = q.toString();
    return fetch(
      `/repos/${encodeURIComponent(repo)}/refs/search${qs ? `?${qs}` : ""}`,
    ).then((r) => json<RefSearchResults>(r));
  },

  threads: (opts: { status?: string; repo?: string; space?: string; worktree?: string | null } = {}) => {
    const q = new URLSearchParams();
    if (opts.status) q.set("status", opts.status);
    if (opts.repo) q.set("repo", opts.repo);
    if (opts.space) q.set("space", opts.space);
    if (opts.worktree) q.set("worktree", opts.worktree);
    const qs = q.toString();
    return fetch(`/threads${qs ? `?${qs}` : ""}`).then((r) => json<Thread[]>(r));
  },

  createThread: (req: CreateThreadRequest) =>
    fetch("/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    }).then((r) => json<Thread>(r)),

  reply: (id: string, req: AddCommentRequest) =>
    post(`/threads/${encodeURIComponent(id)}/comments`, req),

  resolve: (id: string, req: ResolveThreadRequest = {}) =>
    post(`/threads/${encodeURIComponent(id)}/resolve`, req),

  delete: (id: string) =>
    fetch(`/threads/${encodeURIComponent(id)}/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((r) => json<{ ok: boolean }>(r)),

  open: (req: OpenRequest) =>
    fetch("/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    }).then((r) => json<{ ok: boolean }>(r)),

  openUrl: (req: OpenUrlRequest) =>
    fetch("/open-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    }).then((r) => json<{ ok: boolean }>(r)),

  /**
   * Archive (`archived: true`) or revive (`archived: false`) a review session.
   * Sends only the scope — the server re-derives the session id from it and never
   * trusts a client-supplied id, so the unscoped bucket (no scope) is un-archivable.
   */
  archiveSession: (repo: string, req: ArchiveSessionRequest) =>
    fetch(`/repos/${encodeURIComponent(repo)}/sessions/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    }).then((r) => json<{ ok: boolean; archived: ArchivedSession | null }>(r)),

  /**
   * Subscribe to live daemon events; calls onChange with the event type.
   * Returns an unsubscribe function. EventSource auto-reconnects on drop.
   */
  subscribe: (onChange: (type: DaemonEventType) => void): (() => void) => {
    const es = new EventSource("/events");
    for (const type of Object.values(DAEMON_EVENTS)) {
      es.addEventListener(type, () => onChange(type));
    }
    return () => es.close();
  },
};

function post(path: string, body: unknown): Promise<Thread> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => json<Thread>(r));
}
