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

  diff: (repo: string) =>
    fetch(`/repos/${encodeURIComponent(repo)}/diff`).then((r) =>
      json<RepoDiff>(r),
    ),

  threads: (status?: string) =>
    fetch(`/threads${status ? `?status=${status}` : ""}`).then((r) =>
      json<Thread[]>(r),
    ),

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
