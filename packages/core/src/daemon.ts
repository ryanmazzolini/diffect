import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type {
  CreateReviewRequest,
  CurrentChangesResponse,
  ReviewDiff,
  ReviewResponse,
  WorkspaceMutationRequest,
} from "@diffect/shared";
import { readWorkFileContent } from "./git/content.js";
import { computeWorkDiff } from "./git/diff.js";
import { GitChangeStream } from "./events.js";
import {
  DuplicateReviewIdError,
  DuplicateReviewThreadIdError,
  DuplicateWritableReviewError,
  ExistingWritableReviewError,
  InvalidFirstReviewCommentError,
  ReviewService,
  UnknownReviewError,
  UnknownReviewThreadError,
  type ReviewContext,
} from "./reviews/service.js";
import {
  ReviewStoreCorruptError,
  validReviewLocation,
} from "./reviews/store.js";
import {
  addWorkspaceToRegistry,
  readWorkspaceRegistry,
  removeWorkspaceFromRegistry,
} from "./store/registry.js";
import {
  discoverWorkspace,
  findRepo,
  mergeWorkspaces,
  summarizeRepos,
  summarizeWorkspace,
  type DiscoveredRepo,
  type DiscoveredWorktree,
  type Workspace,
} from "./workspace.js";

export interface DaemonOptions {
  workspacePath?: string;
  webRoot?: string;
  host?: string;
  reviewService?: ReviewService;
}

interface RouteContext {
  workspaces: Workspace[];
  workspace: Workspace;
  seed: string | null;
  host: string;
  webRoot?: string;
  reviews: ReviewService;
  events: GitChangeStream;
}

async function loadWorkspaces(seed: string | null): Promise<Workspace[]> {
  const paths = await readWorkspaceRegistry();
  if (seed && !paths.includes(seed)) paths.push(seed);
  const uniquePaths = [...new Set(paths.map((path) => resolve(path)))];
  const discovered = await Promise.all(
    uniquePaths.map((path) =>
      discoverWorkspace(path).catch((error) => {
        process.stderr.write(
          `diffectd: skipping workspace ${path}: ${error?.message ?? error}\n`,
        );
        return null;
      }),
    ),
  );
  return discovered.filter((workspace): workspace is Workspace => workspace !== null);
}

async function rebuildWorkspaces(context: RouteContext): Promise<void> {
  context.workspaces = await loadWorkspaces(context.seed);
  context.workspace = mergeWorkspaces(context.workspaces);
  context.events.rebuild(context.workspace);
}

export async function createServer(options: DaemonOptions = {}): Promise<Server> {
  const seed = options.workspacePath ? resolve(options.workspacePath) : null;
  const workspaces = await loadWorkspaces(seed);
  const workspace = mergeWorkspaces(workspaces);
  const events = new GitChangeStream(workspace);
  events.start();
  const context: RouteContext = {
    workspaces,
    workspace,
    seed,
    host: options.host ?? "127.0.0.1",
    webRoot: options.webRoot,
    reviews: options.reviewService ?? new ReviewService(),
    events,
  };

  const server = createHttpServer((request, response) => {
    handle(context, request, response).catch((error) => {
      if (response.headersSent) return;
      if (error instanceof BodyTooLargeError) {
        sendJson(response, 413, { error: "request body too large" }, true);
        return;
      }
      if (error instanceof UnsupportedMediaTypeError) {
        sendJson(response, 415, { error: "content-type must be application/json" });
        return;
      }
      if (
        error instanceof UnknownReviewError ||
        error instanceof UnknownReviewThreadError
      ) {
        sendJson(response, 404, { error: error.message });
        return;
      }
      if (error instanceof ExistingWritableReviewError) {
        sendJson(response, 409, {
          error: error.message,
          review: error.review,
          link: context.reviews.linkFor(error.review.id),
        });
        return;
      }
      if (error instanceof InvalidFirstReviewCommentError) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (
        error instanceof ReviewStoreCorruptError ||
        error instanceof DuplicateReviewIdError ||
        error instanceof DuplicateReviewThreadIdError ||
        error instanceof DuplicateWritableReviewError
      ) {
        process.stderr.write(`diffectd: ${error.stack ?? error}\n`);
        sendJson(response, 500, { error: "Review store is corrupt" });
        return;
      }
      process.stderr.write(`diffectd: ${error?.stack ?? error}\n`);
      sendJson(response, 500, { error: "internal error" });
    });
  });
  server.on("close", () => events.close());
  return server;
}

async function handle(
  context: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const method = request.method ?? "GET";
  const path = url.pathname;

  if (isLoopback(context.host) && !isLoopbackRequest(request)) {
    sendJson(response, 403, {
      error: "loopback daemon requires a loopback host and origin",
    });
    return;
  }

  if (method === "GET" && path === "/api/health") {
    sendJson(response, 200, { ok: true, model: "review" });
    return;
  }

  if (method === "GET" && path === "/api/events") {
    const dispose = context.events.addClient(response);
    request.on("close", dispose);
    return;
  }

  if (method === "GET" && path === "/api/workspace") {
    sendJson(response, 200, await summarizeWorkspace(context.workspace));
    return;
  }

  if (method === "POST" && path === "/api/workspaces") {
    const body = await readJson<WorkspaceMutationRequest>(request);
    if (!body || typeof body.path !== "string" || !body.path.trim()) {
      sendJson(response, 400, { error: "path is required" });
      return;
    }
    try {
      await discoverWorkspace(body.path);
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "invalid workspace",
      });
      return;
    }
    await addWorkspaceToRegistry(body.path);
    await rebuildWorkspaces(context);
    sendJson(response, 200, await summarizeWorkspace(context.workspace));
    return;
  }

  if (method === "DELETE" && path === "/api/workspaces") {
    const body = await readJson<WorkspaceMutationRequest>(request);
    if (!body || typeof body.path !== "string" || !body.path.trim()) {
      sendJson(response, 400, { error: "path is required" });
      return;
    }
    await removeWorkspaceFromRegistry(body.path);
    await rebuildWorkspaces(context);
    sendJson(response, 200, await summarizeWorkspace(context.workspace));
    return;
  }

  if (method === "GET" && path === "/api/current-changes") {
    const selected = selectWorkingContext(
      context.workspace,
      url.searchParams.get("repo"),
      url.searchParams.get("worktree"),
    );
    if ("error" in selected) {
      sendJson(response, selected.status, { error: selected.error });
      return;
    }
    sendJson(response, 200, await currentChanges(context, selected));
    return;
  }

  if (method === "POST" && path === "/api/reviews") {
    const body = await readJson<CreateReviewRequest>(request);
    if (!validCreateRequest(body)) {
      sendJson(response, 400, { error: "invalid first Review comment" });
      return;
    }
    const selected = selectWorkingContext(
      context.workspace,
      body.repo,
      body.worktree,
    );
    if ("error" in selected) {
      sendJson(response, selected.status, { error: selected.error });
      return;
    }
    const diff = await reviewDiff(selected);
    const file = diff.files.find((candidate) => candidate.path === body.location.path);
    if (!file || !rangeExists(file, body.location.side, body.location.startLine, body.location.endLine)) {
      sendJson(response, 400, {
        error: "selected line range is not present in Current changes",
      });
      return;
    }
    const review = await context.reviews.promoteFirstComment(
      reviewContext(selected),
      body,
    );
    sendJson(response, 201, {
      review,
      link: context.reviews.linkFor(review.id),
    } satisfies ReviewResponse);
    return;
  }

  const reviewDiffMatch = /^\/api\/reviews\/([^/]+)\/diff$/.exec(path);
  if (method === "GET" && reviewDiffMatch) {
    const review = await context.reviews.getReview(reviewDiffMatch[1]!);
    const selected = await locateReviewContext(context.workspace, review);
    if (!selected) {
      sendJson(response, 409, {
        error: "Review code is unavailable; its conversation is still readable",
      });
      return;
    }
    sendJson(response, 200, await reviewDiff(selected));
    return;
  }

  const reviewMatch = /^\/api\/reviews\/([^/]+)$/.exec(path);
  if (method === "GET" && reviewMatch) {
    const review = await context.reviews.getReview(reviewMatch[1]!);
    sendJson(response, 200, {
      review,
      link: context.reviews.linkFor(review.id),
    } satisfies ReviewResponse);
    return;
  }

  const threadMatch = /^\/api\/review-threads\/([^/]+)$/.exec(path);
  if (method === "GET" && threadMatch) {
    const exact = await context.reviews.getThread(threadMatch[1]!);
    sendJson(response, 200, {
      ...exact,
      reviewLink: context.reviews.linkFor(exact.review.id),
    });
    return;
  }

  if (path.startsWith("/api/") || isRemovedLegacyPath(path)) {
    sendJson(response, 404, { error: "not found" });
    return;
  }

  await serveStatic(context.webRoot, path, method, response);
}

interface SelectedContext {
  repo: DiscoveredRepo;
  worktree: DiscoveredWorktree;
  worktreeName: string | null;
}

type SelectionResult = SelectedContext | { error: string; status: 400 | 404 };

function selectWorkingContext(
  workspace: Workspace,
  requestedRepo: string | null,
  requestedWorktree: string | null,
): SelectionResult {
  const repo = requestedRepo
    ? findRepo(workspace, requestedRepo)
    : workspace.repos.length === 1
      ? workspace.repos[0]
      : undefined;
  if (!repo) {
    return {
      status: requestedRepo ? 404 : 400,
      error: requestedRepo ? `unknown repository: ${requestedRepo}` : "repo is required",
    };
  }
  const worktree = requestedWorktree
    ? repo.worktrees.find((candidate) => candidate.name === requestedWorktree)
    : repo.worktrees.find((candidate) => candidate.root === repo.root);
  if (!worktree) {
    return {
      status: 404,
      error: `unknown worktree: ${requestedWorktree ?? "primary"}`,
    };
  }
  return {
    repo,
    worktree,
    worktreeName: worktree.root === repo.root ? null : worktree.name,
  };
}

function reviewContext(selected: SelectedContext): ReviewContext {
  return {
    repositoryRoot: selected.repo.root,
    worktreeRoot: selected.worktree.root,
  };
}

async function currentChanges(
  context: RouteContext,
  selected: SelectedContext,
): Promise<CurrentChangesResponse> {
  const repository = (await summarizeRepos([selected.repo]))[0]!;
  const worktree = repository.worktrees.find(
    (candidate) => candidate.root === selected.worktree.root,
  )!;
  const [review, diff] = await Promise.all([
    context.reviews.findWritable(reviewContext(selected)),
    reviewDiff(selected),
  ]);
  return { repository, worktree, review, diff };
}

async function reviewDiff(selected: SelectedContext): Promise<ReviewDiff> {
  const diff = await computeWorkDiff(selected.worktree.root);
  const files = await Promise.all(
    diff.files.map(async (file) => ({
      ...file,
      ...(await readWorkFileContent(
        selected.worktree.root,
        file.path,
        file.oldPath ?? file.path,
      )),
    })),
  );
  return {
    repo: selected.repo.name,
    worktree: selected.worktreeName,
    target: "work",
    files,
  };
}

async function locateReviewContext(
  workspace: Workspace,
  review: { repository: { root: string }; worktree: { root: string } },
): Promise<SelectedContext | null> {
  for (const repo of workspace.repos) {
    let repositoryRoot: string;
    try {
      repositoryRoot = await realpath(repo.root);
    } catch {
      continue;
    }
    if (repositoryRoot !== review.repository.root) continue;
    for (const worktree of repo.worktrees) {
      try {
        if ((await realpath(worktree.root)) === review.worktree.root) {
          return {
            repo,
            worktree,
            worktreeName: worktree.root === repo.root ? null : worktree.name,
          };
        }
      } catch {
        // Continue looking; exact Review metadata remains readable.
      }
    }
  }
  return null;
}

function validCreateRequest(value: unknown): value is CreateReviewRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<CreateReviewRequest>;
  return (
    typeof request.repo === "string" &&
    request.repo.length > 0 &&
    (request.worktree === null || typeof request.worktree === "string") &&
    validReviewLocation(request.location) &&
    (request.severity === null ||
      request.severity === "must-fix" ||
      request.severity === "suggestion" ||
      request.severity === "nit" ||
      request.severity === "question") &&
    !!request.author &&
    (request.author.type === "user" || request.author.type === "agent") &&
    (request.author.name === undefined ||
      (typeof request.author.name === "string" && request.author.name.trim().length > 0)) &&
    typeof request.body === "string" &&
    request.body.trim().length > 0
  );
}

function rangeExists(
  file: { old: string | null; new: string | null },
  side: "old" | "new",
  startLine: number,
  endLine: number,
): boolean {
  const content = file[side];
  if (content === null) return false;
  const lineCount = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  return startLine > 0 && endLine >= startLine && endLine <= lineCount;
}

class BodyTooLargeError extends Error {}
class UnsupportedMediaTypeError extends Error {}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw new UnsupportedMediaTypeError();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1_048_576) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new InvalidFirstReviewCommentError("request body must be valid JSON");
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  close = false,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...(close ? { connection: "close" } : {}),
  });
  response.end(body);
}

async function serveStatic(
  webRoot: string | undefined,
  requestPath: string,
  method: string,
  response: ServerResponse,
): Promise<void> {
  if (method !== "GET" && method !== "HEAD") {
    sendJson(response, 405, { error: "method not allowed" });
    return;
  }
  if (!webRoot) {
    sendJson(response, 404, { error: "not found" });
    return;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    sendJson(response, 400, { error: "invalid path" });
    return;
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  let candidate = resolve(webRoot, relative);
  const root = resolve(webRoot);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    sendJson(response, 404, { error: "not found" });
    return;
  }

  let file = await fileStat(candidate);
  if (!file && !extname(relative)) {
    candidate = join(root, "index.html");
    file = await fileStat(candidate);
  }
  if (!file?.isFile()) {
    sendJson(response, 404, { error: "not found" });
    return;
  }

  response.writeHead(200, {
    "content-type": mimeType(candidate),
    "content-length": file.size,
  });
  if (method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(candidate).pipe(response);
}

async function fileStat(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

function mimeType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}

function isRemovedLegacyPath(path: string): boolean {
  return (
    path === "/workspace" ||
    path === "/workspaces" ||
    path === "/events" ||
    path === "/threads" ||
    path === "/open-reviews" ||
    path === "/settings" ||
    path === "/ui-state" ||
    path === "/workspace-resolution" ||
    path === "/pr-draft" ||
    path === "/space/files" ||
    path === "/space/file" ||
    path === "/open" ||
    path === "/open-url" ||
    path === "/attachments" ||
    path === "/recommendations" ||
    path === "/fs/list" ||
    path.startsWith("/repos/") ||
    path.startsWith("/threads/") ||
    path.startsWith("/attachments/")
  );
}

function isLoopback(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const host = request.headers.host;
  if (!host || !isLoopbackAuthority(host)) return false;
  const origin = request.headers.origin;
  return !origin || isLoopbackOrigin(origin);
}

function isLoopbackAuthority(value: string): boolean {
  try {
    const url = new URL(`http://${value}`);
    return (
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      isLoopback(url.hostname)
    );
  } catch {
    return false;
  }
}

function isLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      (url.pathname === "" || url.pathname === "/") &&
      !url.search &&
      !url.hash &&
      isLoopback(url.hostname)
    );
  } catch {
    return false;
  }
}
