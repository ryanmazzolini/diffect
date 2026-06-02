import { DAEMON_EVENTS } from "@diffect/shared";
import type {
  AddCommentRequest,
  CreateThreadRequest,
  DaemonEventType,
  DismissThreadRequest,
  FileRange,
  OpenRequest,
  RefList,
  RepoDiff,
  ResolveThreadRequest,
  Thread,
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
