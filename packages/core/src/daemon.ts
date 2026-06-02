import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type {
  AddCommentRequest,
  CreateThreadRequest,
  DeleteThreadRequest,
  DismissThreadRequest,
  OpenRequest,
  ResolveThreadRequest,
  WorkspaceEntry,
  WorkspaceMutationRequest,
} from "@diffect/shared";
import { resolveWorkBase } from "./git/diff.js";
import { computeTargetDiff, normalizeTarget } from "./git/target.js";
import { buildAnchor } from "./reviews/anchors.js";
import {
  addComment,
  createThread,
  deleteThread,
  dismissThread,
  resolveThread,
  UnknownThreadError,
} from "./reviews/event-log.js";
import {
  findRepoRootForThread,
  loadAllThreads,
  loadRefreshedThreads,
} from "./reviews/refresh.js";
import { EventHub } from "./events.js";
import {
  detectEditors,
  openInEditor,
  PathEscapeError,
  UnknownEditorError,
} from "./editor.js";
import {
  discoverWorkspace,
  findRepo,
  mergeWorkspaces,
  resolveRepoRoot,
  summarizeRepos,
  summarizeWorkspace,
  type DiscoveredRepo,
  type Workspace,
} from "./workspace.js";
import {
  addWorkspaceToRegistry,
  readWorkspaceRegistry,
  removeWorkspaceFromRegistry,
} from "./store/registry.js";

export interface DaemonOptions {
  /** Workspace to serve at boot, always included even if not yet registered. */
  workspacePath?: string;
  /** Directory of built web assets to serve; omit to run API-only. */
  webRoot?: string;
  /** Bind host; gates workspace-mutation routes to loopback. */
  host?: string;
  /** Clock injection for deterministic tests. */
  now?: () => string;
}

interface RouteContext {
  /** Per-path discovered workspaces (source of the /workspaces breakdown). */
  workspaces: Workspace[];
  /** Aggregate view (union of all repos, globally deduped) used by repo routes. */
  ws: Workspace;
  /** Boot workspace, always re-included on rebuild even if not in the registry. */
  seed: string | null;
  host: string;
  now: () => string;
  webRoot?: string;
  events: EventHub;
  editors: string[];
}

/** Discover every registered workspace plus the boot seed; skip unreadable ones. */
async function loadWorkspaces(seed: string | null): Promise<Workspace[]> {
  const paths = await readWorkspaceRegistry();
  if (seed && !paths.includes(seed)) paths.push(seed);
  const discovered = await Promise.all(
    paths.map((p) =>
      discoverWorkspace(p).catch((err) => {
        process.stderr.write(
          `diffectd: skipping workspace ${p}: ${err?.message ?? err}\n`,
        );
        return null;
      }),
    ),
  );
  return discovered.filter((w): w is Workspace => w !== null);
}

/** Re-read the registry and rebuild the aggregate + watchers after a change. */
async function rebuildWorkspaces(ctx: RouteContext): Promise<void> {
  ctx.workspaces = await loadWorkspaces(ctx.seed);
  ctx.ws = mergeWorkspaces(ctx.workspaces);
  ctx.events.rebuild(ctx.ws);
}

/**
 * Build the diffectd HTTP server. The daemon is a thin wrapper over `git diff`
 * and the central review event log — the file store remains the source of truth,
 * so the CLI and agents work the same whether or not this is running.
 */
export async function createServer(opts: DaemonOptions): Promise<Server> {
  const seed = opts.workspacePath ? resolve(opts.workspacePath) : null;
  const workspaces = await loadWorkspaces(seed);
  const ws = mergeWorkspaces(workspaces);
  const events = new EventHub(ws);
  events.start();
  const editors = await detectEditors();
  const ctx: RouteContext = {
    workspaces,
    ws,
    seed,
    host: opts.host ?? "127.0.0.1",
    now: opts.now ?? (() => new Date().toISOString()),
    webRoot: opts.webRoot,
    events,
    editors,
  };

  const server = createHttpServer((req, res) => {
    handle(ctx, req, res).catch((err) => {
      if (err instanceof BodyTooLargeError) {
        // Close the connection after responding: the client may still be
        // uploading, and we've stopped reading, so keep-alive would stall.
        if (!res.headersSent) {
          const json = JSON.stringify({ error: "request body too large" });
          res.writeHead(413, {
            "content-type": "application/json; charset=utf-8",
            "content-length": Buffer.byteLength(json),
            connection: "close",
          });
          res.end(json);
        }
        return;
      }
      // Don't leak internals (paths, stack traces) to the client; log instead.
      process.stderr.write(`diffectd: ${err?.stack ?? err}\n`);
      sendJson(res, 500, { error: "internal error" });
    });
  });

  // Tear down filesystem watchers when the server closes.
  server.on("close", () => ctx.events.close());
  return server;
}

async function handle(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // --- Live updates (SSE) -------------------------------------------------
  if (method === "GET" && path === "/events") {
    const dispose = ctx.events.addClient(res);
    req.on("close", dispose);
    return; // keep the connection open
  }

  // --- API routes ---------------------------------------------------------
  if (method === "GET" && path === "/workspace") {
    const threads = await loadAllThreads(ctx.ws);
    const open = threads.filter((t) => t.status === "open").length;
    return sendJson(res, 200, await summarizeWorkspace(ctx.ws, open, ctx.editors));
  }

  // --- Workspaces (multi-workspace management) ----------------------------
  if (method === "GET" && path === "/workspaces") {
    return sendJson(res, 200, await listWorkspaces(ctx));
  }
  if ((method === "POST" || method === "DELETE") && path === "/workspaces") {
    if (!isLoopback(ctx.host)) {
      // Adding/removing a workspace opens an arbitrary host path; only allow it
      // when the daemon is bound to loopback, never over a shared network.
      return sendJson(res, 403, {
        error: "workspace management is only allowed on a loopback-bound daemon",
      });
    }
    const body = await readJsonBody<WorkspaceMutationRequest>(req);
    if (!body || typeof body.path !== "string" || !body.path.trim()) {
      return sendJson(res, 400, { error: "path is required" });
    }
    if (method === "POST") {
      // Validate it's a real workspace (has a git repo) before registering.
      try {
        await discoverWorkspace(resolve(body.path));
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message });
      }
      await addWorkspaceToRegistry(body.path);
    } else {
      await removeWorkspaceFromRegistry(body.path);
    }
    await rebuildWorkspaces(ctx);
    return sendJson(res, 200, await listWorkspaces(ctx));
  }

  if (method === "GET" && path === "/threads") {
    const status = url.searchParams.get("status");
    const repoFilter = url.searchParams.get("repo");
    const worktreeFilter = url.searchParams.get("worktree");
    let threads = await loadRefreshedThreads(ctx.ws);
    if (status) threads = threads.filter((t) => t.status === status);
    if (repoFilter) threads = threads.filter((t) => t.repo === repoFilter);
    if (worktreeFilter)
      threads = threads.filter((t) => t.worktree === worktreeFilter);
    return sendJson(res, 200, threads);
  }

  const diffMatch = /^\/repos\/(.+)\/diff$/.exec(path);
  if (method === "GET" && diffMatch) {
    const repoName = decodeURIComponent(diffMatch[1]!);
    const repo = findRepo(ctx.ws, repoName);
    if (!repo) return sendJson(res, 404, { error: `unknown repo: ${repoName}` });
    const worktree = url.searchParams.get("worktree");
    const treeRoot = resolveRepoRoot(ctx.ws, repo.name, worktree);
    if (!treeRoot) {
      return sendJson(res, 404, { error: `unknown worktree: ${worktree}` });
    }
    const target = normalizeTarget(url.searchParams.get("target"));
    const diff = await computeTargetDiff(treeRoot, target);
    return sendJson(res, 200, { ...diff, repo: repo.name, worktree });
  }

  if (method === "POST" && path === "/threads") {
    const body = await readJsonBody<CreateThreadRequest>(req);
    if (!body || typeof body.body !== "string" || !body.body.trim()) {
      return sendJson(res, 400, { error: "body is required" });
    }
    const repo = body.repo ? findRepo(ctx.ws, body.repo) : undefined;
    if (!repo) {
      return sendJson(res, 400, { error: `unknown repo: ${body.repo}` });
    }
    const treeRoot = resolveRepoRoot(ctx.ws, repo.name, body.worktree ?? null);
    if (!treeRoot) {
      return sendJson(res, 400, { error: `unknown worktree: ${body.worktree}` });
    }
    const base = await resolveWorkBase(treeRoot);
    const anchor = await buildAnchor(treeRoot, base, body);
    // The store is keyed by the repo's PRIMARY root so all worktrees share one
    // log (the worktree name lives on the thread); treeRoot is only for anchoring.
    const thread = await createThread(repo.root, { ...body, anchor }, ctx.now());
    return sendJson(res, 201, thread);
  }

  const commentMatch = /^\/threads\/([^/]+)\/comments$/.exec(path);
  if (method === "POST" && commentMatch) {
    const id = decodeURIComponent(commentMatch[1]!);
    const body = await readJsonBody<AddCommentRequest>(req);
    if (!body || typeof body.body !== "string" || !body.body.trim()) {
      return sendJson(res, 400, { error: "body is required" });
    }
    return withThread(res, async () =>
      addComment(await requireRepoRoot(ctx, id), id, body, ctx.now()),
    );
  }

  const resolveMatch = /^\/threads\/([^/]+)\/resolve$/.exec(path);
  if (method === "POST" && resolveMatch) {
    const id = decodeURIComponent(resolveMatch[1]!);
    const body = (await readJsonBody<ResolveThreadRequest>(req)) ?? {};
    return withThread(res, async () =>
      resolveThread(await requireRepoRoot(ctx, id), id, body, ctx.now()),
    );
  }

  const dismissMatch = /^\/threads\/([^/]+)\/dismiss$/.exec(path);
  if (method === "POST" && dismissMatch) {
    const id = decodeURIComponent(dismissMatch[1]!);
    const body = (await readJsonBody<DismissThreadRequest>(req)) ?? {};
    return withThread(res, async () =>
      dismissThread(await requireRepoRoot(ctx, id), id, body, ctx.now()),
    );
  }

  const deleteMatch = /^\/threads\/([^/]+)\/delete$/.exec(path);
  if (method === "POST" && deleteMatch) {
    const id = decodeURIComponent(deleteMatch[1]!);
    const body = (await readJsonBody<DeleteThreadRequest>(req)) ?? {};
    try {
      await deleteThread(await requireRepoRoot(ctx, id), id, body, ctx.now());
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      if (err instanceof UnknownThreadError) {
        return sendJson(res, 404, { error: err.message });
      }
      throw err;
    }
  }

  // --- Editor handoff -----------------------------------------------------
  if (method === "POST" && path === "/open") {
    const body = await readJsonBody<OpenRequest>(req);
    if (!body || !body.file || typeof body.line !== "number" || !body.editor) {
      return sendJson(res, 400, { error: "file, line, and editor are required" });
    }
    const repo = body.repo ? findRepo(ctx.ws, body.repo) : undefined;
    if (!repo) return sendJson(res, 400, { error: `unknown repo: ${body.repo}` });
    const treeRoot = resolveRepoRoot(ctx.ws, repo.name, body.worktree ?? null);
    if (!treeRoot) {
      return sendJson(res, 400, { error: `unknown worktree: ${body.worktree}` });
    }
    try {
      await openInEditor(treeRoot, body.file, body.line, body.editor);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      // Bad input (unsupported editor, path escaping the repo) is a 400, not a
      // server error.
      if (err instanceof UnknownEditorError || err instanceof PathEscapeError) {
        return sendJson(res, 400, { error: err.message });
      }
      throw err;
    }
  }

  // --- Static web assets --------------------------------------------------
  if (method === "GET" && ctx.webRoot) {
    return serveStatic(ctx.webRoot, path, res);
  }

  sendJson(res, 404, { error: "not found" });
}

/**
 * Resolve the central store (repo root) that owns a thread id, scanning every
 * repo in the workspace. Throws UnknownThreadError (→ 404 via withThread) when
 * no repo claims it, so mutations carrying only an id route to the right log.
 */
async function requireRepoRoot(ctx: RouteContext, id: string): Promise<string> {
  const root = await findRepoRootForThread(ctx.ws, id);
  if (!root) throw new UnknownThreadError(id);
  return root;
}

/** Run a thread mutation, mapping a missing thread to 404. */
async function withThread(
  res: ServerResponse,
  op: () => Promise<unknown>,
): Promise<void> {
  try {
    sendJson(res, 200, await op());
  } catch (err) {
    if (err instanceof UnknownThreadError) {
      sendJson(res, 404, { error: err.message });
    } else {
      throw err;
    }
  }
}

/** Group the aggregate repos back by their source workspace path. */
async function listWorkspaces(ctx: RouteContext): Promise<WorkspaceEntry[]> {
  const byPath = new Map<string, DiscoveredRepo[]>();
  for (const repo of ctx.ws.repos) {
    const key = repo.workspacePath ?? ctx.ws.root;
    const list = byPath.get(key);
    if (list) list.push(repo);
    else byPath.set(key, [repo]);
  }
  return Promise.all(
    [...byPath].map(async ([path, repos]) => ({
      path,
      repos: await summarizeRepos(repos),
    })),
  );
}

/** Loopback hosts may manage workspaces; a network-bound daemon may not. */
function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  // A streamed static response may already be in flight; never double-send.
  if (res.headersSent) {
    res.end();
    return;
  }
  const json = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

/** Max accepted request body. Review comments are small; cap to avoid OOM. */
const MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLargeError extends Error {}

async function readJsonBody<T>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      // Stop reading but leave the socket intact so the 413 response can flush;
      // pausing avoids buffering the rest of an oversize upload.
      req.pause();
      throw new BodyTooLargeError();
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(
  webRoot: string,
  urlPath: string,
  res: ServerResponse,
): Promise<void> {
  const root = resolve(webRoot);
  // Decode percent-escapes so `%2e%2e` can't smuggle a `..` past the check, then
  // resolve and confirm the result stays inside webRoot. Use a path-boundary
  // compare (root, or root + separator) so a sibling dir sharing the prefix
  // (e.g. `/a/web-secret` for root `/a/web`) cannot escape.
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return sendJson(res, 400, { error: "bad path" });
  }
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  let filePath = resolve(root, rel);
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    return sendJson(res, 403, { error: "forbidden" });
  }
  let info = await stat(filePath).catch(() => null);
  if (!info || info.isDirectory()) {
    // SPA fallback: unknown client routes serve index.html.
    filePath = join(root, "index.html");
    info = await stat(filePath).catch(() => null);
    if (!info) return sendJson(res, 404, { error: "not found" });
  }
  res.writeHead(200, {
    "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
    "content-length": info.size,
  });
  const stream = createReadStream(filePath);
  // If the file vanishes mid-stream or the client aborts, tear down cleanly
  // instead of leaking an unhandled stream error or a dangling fd.
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}
