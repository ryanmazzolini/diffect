import { DAEMON_EVENTS } from "@diffect/shared";
import type {
  AddCommentRequest,
  AttachmentResponse,
  CreateThreadRequest,
  DaemonEventType,
  DismissThreadRequest,
  FileRange,
  FsListing,
  OpenRequest,
  RecommendedWorkspace,
  RefList,
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

  refs: (repo: string, worktree?: string | null) => {
    const q = new URLSearchParams();
    if (worktree) q.set("worktree", worktree);
    const qs = q.toString();
    return fetch(
      `/repos/${encodeURIComponent(repo)}/refs${qs ? `?${qs}` : ""}`,
    ).then((r) => json<RefList>(r));
  },

  threads: (opts: { status?: string; repo?: string; worktree?: string | null } = {}) => {
    const q = new URLSearchParams();
    if (opts.status) q.set("status", opts.status);
    if (opts.repo) q.set("repo", opts.repo);
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

  dismiss: (id: string, req: DismissThreadRequest = {}) =>
    post(`/threads/${encodeURIComponent(id)}/dismiss`, req),

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
