import { DAEMON_EVENTS } from "@diffect/shared";
import type {
  AddCommentRequest,
  AttachmentResponse,
  CreateThreadRequest,
  DaemonEventPayload,
  DaemonEventType,
  FileContent,
  FileRange,
  FsListing,
  OpenRequest,
  OpenReviewSummary,
  OpenUrlRequest,
  PrDraft,
  PrDraftUpdateRequest,
  RecommendedWorkspace,
  RefList,
  RefSearchResults,
  RepoDiff,
  RepoFileList,
  ResolveThreadRequest,
  Thread,
  UiState,
  UiStateUpdate,
  WorkspaceEntry,
  WorkspaceInfo,
  WriteFileContentRequest,
  WriteFileContentResponse,
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

function prDraftQuery(workspacePath: string, repo?: string, worktree?: string | null): URLSearchParams {
  const q = new URLSearchParams({ workspace: workspacePath });
  if (repo) q.set("repo", repo);
  if (worktree) q.set("worktree", worktree);
  return q;
}

export const api = {
  workspace: (workspacePath?: string | null) => {
    const q = workspacePath ? `?workspace=${encodeURIComponent(workspacePath)}` : "";
    return fetch(`/workspace${q}`).then((r) => json<WorkspaceInfo>(r));
  },

  openReviews: (workspacePath: string, repo: string) => {
    const q = new URLSearchParams({ workspace: workspacePath, repo });
    return fetch(`/open-reviews?${q}`).then((r) => json<OpenReviewSummary[]>(r));
  },

  uiState: () => fetch("/ui-state").then((r) => json<UiState>(r)),

  updateUiState: (req: UiStateUpdate) =>
    fetch("/ui-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    }).then((r) => json<UiState>(r)),

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

  repoFiles: (repo: string, worktree?: string | null, includeIgnored = false) => {
    const q = new URLSearchParams();
    if (worktree) q.set("worktree", worktree);
    if (includeIgnored) q.set("includeIgnored", "1");
    const qs = q.toString();
    return fetch(`/repos/${encodeURIComponent(repo)}/files${qs ? `?${qs}` : ""}`).then((r) =>
      json<RepoFileList>(r),
    );
  },

  spaceFiles: (workspacePath: string) => {
    const q = new URLSearchParams({ workspace: workspacePath });
    return fetch(`/space/files?${q}`).then((r) => json<RepoFileList>(r));
  },

  spaceFile: (workspacePath: string, opts: { path: string; from: number; to: number }) => {
    const q = new URLSearchParams({
      workspace: workspacePath,
      path: opts.path,
      from: String(opts.from),
      to: String(opts.to),
    });
    return fetch(`/space/file?${q}`).then((r) => json<FileRange>(r));
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

  diff: (repo: string, opts: { worktree?: string | null; target?: string; includeIgnored?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.worktree) q.set("worktree", opts.worktree);
    if (opts.target) q.set("target", opts.target);
    if (opts.includeIgnored) q.set("includeIgnored", "1");
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

  writeFileContent: (
    repo: string,
    opts: { path: string; target?: string; worktree?: string | null } & WriteFileContentRequest,
  ) => {
    const q = new URLSearchParams({ path: opts.path });
    if (opts.target) q.set("target", opts.target);
    if (opts.worktree) q.set("worktree", opts.worktree);
    return fetch(`/repos/${encodeURIComponent(repo)}/file/content?${q}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: opts.content }),
    }).then((r) => json<WriteFileContentResponse>(r));
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
    opts: {
      query?: string;
      limit?: number;
      branchOffset?: number;
      branchLimit?: number;
      remoteOffset?: number;
      remoteLimit?: number;
      commitOffset?: number;
      commitLimit?: number;
      worktree?: string | null;
    } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.query) q.set("q", opts.query);
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.branchOffset) q.set("branchOffset", String(opts.branchOffset));
    if (opts.branchLimit) q.set("branchLimit", String(opts.branchLimit));
    if (opts.remoteOffset) q.set("remoteOffset", String(opts.remoteOffset));
    if (opts.remoteLimit) q.set("remoteLimit", String(opts.remoteLimit));
    if (opts.commitOffset) q.set("commitOffset", String(opts.commitOffset));
    if (opts.commitLimit) q.set("commitLimit", String(opts.commitLimit));
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

  prDraft: (workspacePath: string, repo?: string, worktree?: string | null) => {
    const q = prDraftQuery(workspacePath, repo, worktree);
    return fetch(`/pr-draft?${q}`).then((r) => json<PrDraft>(r));
  },

  updatePrDraft: (
    workspacePath: string,
    repo: string | undefined,
    worktree: string | null | undefined,
    req: PrDraftUpdateRequest,
  ) => {
    const q = prDraftQuery(workspacePath, repo, worktree);
    return fetch(`/pr-draft?${q}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    }).then((r) => json<PrDraft>(r));
  },

  /**
   * Subscribe to live daemon events; calls onChange with the event type.
   * Returns an unsubscribe function. EventSource auto-reconnects on drop.
   */
  subscribe: (onChange: (type: DaemonEventType, payload: DaemonEventPayload) => void): (() => void) => {
    const es = new EventSource("/events");
    for (const type of Object.values(DAEMON_EVENTS)) {
      es.addEventListener(type, (event) => onChange(type, parseEventPayload(event)));
    }
    return () => es.close();
  },
};

function parseEventPayload(event: Event): DaemonEventPayload {
  const data = event instanceof MessageEvent ? event.data : null;
  if (typeof data !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed && typeof parsed === "object" ? (parsed as DaemonEventPayload) : {};
  } catch {
    return {};
  }
}

function post(path: string, body: unknown): Promise<Thread> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => json<Thread>(r));
}
