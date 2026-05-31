import type {
  AddCommentRequest,
  CreateThreadRequest,
  DismissThreadRequest,
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
};

function post(path: string, body: unknown): Promise<Thread> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => json<Thread>(r));
}
