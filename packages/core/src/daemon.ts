import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import {
  DAEMON_EVENTS,
  type AddCommentRequest,
  type ArchiveSessionRequest,
  type CreateThreadRequest,
  type DeleteThreadRequest,
  type OpenRequest,
  type OpenUrlRequest,
  type ResolveThreadRequest,
  type WorkspaceEntry,
  type WorkspaceMutationRequest,
} from "@diffect/shared";
import { readTargetFileContent } from "./git/content.js";
import { resolveWorkBase } from "./git/diff.js";
import { listRefs, listTrackedFiles, searchRefs } from "./git/refs.js";
import { computeTargetDiff, normalizeTarget } from "./git/target.js";
import { buildAnchor, readSideLines } from "./reviews/anchors.js";
import {
  resolveScope,
  sessionIdForScope,
  snapshotIdForState,
} from "./reviews/scope.js";
import {
  addComment,
  archiveSession,
  createThread,
  deleteThread,
  resolveThread,
  spaceThreadStore,
  UnknownThreadError,
  UnscopedSessionError,
  type ThreadStoreRef,
} from "./reviews/event-log.js";
import {
  findStoreForThread,
  loadAllThreads,
  loadRefreshedThreads,
  workspacePaths,
} from "./reviews/refresh.js";
import { EventHub } from "./events.js";
import {
  detectEditors,
  openInEditor,
  PathEscapeError,
  UnknownEditorError,
} from "./editor.js";
import { openExternalUrl, UnsupportedUrlError } from "./open-url.js";
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
import {
  attachmentMime,
  attachmentPath,
  isValidAttachmentId,
  storeAttachment,
} from "./store/attachments.js";
import { FsBrowseError, listDir, recommendations } from "./store/discovery.js";

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

  // Delegate to route groups; each returns true once it has sent a response.
  if (await workspaceRoutes(ctx, req, res, method, path)) return;
  if (await threadCollectionRoutes(ctx, req, res, url, method, path)) return;
  if (await threadItemRoutes(ctx, req, res, method, path)) return;
  if (await sessionRoutes(ctx, req, res, method, path)) return;
  if (await repoRoutes(ctx, res, url, method, path)) return;
  if (await fileContentRoute(ctx, res, url, method, path)) return;
  if (await fileRoute(ctx, res, url, method, path)) return;
  if (await editorRoute(ctx, req, res, method, path)) return;
  if (await externalUrlRoute(ctx, req, res, method, path)) return;
  if (await attachmentRoutes(ctx, req, res, method, path)) return;
  if (await discoveryRoutes(ctx, res, url, method, path)) return;

  // --- Static web assets --------------------------------------------------
  if (method === "GET" && ctx.webRoot) {
    return serveStatic(ctx.webRoot, path, res);
  }

  sendJson(res, 404, { error: "not found" });
}

/** `/workspace` summary + `/workspaces` list/add/remove. */
async function workspaceRoutes(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (method === "GET" && path === "/workspace") {
    const threads = await loadAllThreads(ctx.ws);
    const open = threads.filter((t) => t.status === "open").length;
    sendJson(res, 200, await summarizeWorkspace(ctx.ws, open, ctx.editors));
    return true;
  }
  if (method === "GET" && path === "/workspaces") {
    sendJson(res, 200, await listWorkspaces(ctx));
    return true;
  }
  if ((method === "POST" || method === "DELETE") && path === "/workspaces") {
    return mutateWorkspaceRoute(ctx, req, res, method);
  }
  return false;
}

async function mutateWorkspaceRoute(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
): Promise<boolean> {
  if (!isLoopback(ctx.host)) {
    // Adding/removing a workspace opens an arbitrary host path; only allow it
    // when the daemon is bound to loopback, never over a shared network.
    sendJson(res, 403, {
      error: "workspace management is only allowed on a loopback-bound daemon",
    });
    return true;
  }
  const body = await readJsonBody<WorkspaceMutationRequest>(req);
  if (!body || typeof body.path !== "string" || !body.path.trim()) {
    sendJson(res, 400, { error: "path is required" });
    return true;
  }
  if (method === "POST") {
    // Validate it's a real workspace (has a git repo) before registering.
    try {
      await discoverWorkspace(resolve(body.path));
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
      return true;
    }
    await addWorkspaceToRegistry(body.path);
  } else {
    await removeWorkspaceFromRegistry(body.path);
  }
  await rebuildWorkspaces(ctx);
  sendJson(res, 200, await listWorkspaces(ctx));
  return true;
}

/** `GET /threads` (filtered) and `POST /threads` (create). */
async function threadCollectionRoutes(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  path: string,
): Promise<boolean> {
  if (method === "GET" && path === "/threads") {
    const rawStatus = url.searchParams.get("status");
    // "resolved" stays accepted as a silent alias for the renamed "closed" status.
    const status = rawStatus === "resolved" ? "closed" : rawStatus;
    const repoFilter = url.searchParams.get("repo");
    const spaceFilter = url.searchParams.get("space");
    const worktreeFilter = url.searchParams.get("worktree");
    const sessionFilter = url.searchParams.get("session");
    let threads = await loadRefreshedThreads(ctx.ws);
    if (status) threads = threads.filter((t) => t.status === status);
    if (repoFilter) threads = threads.filter((t) => t.repo === repoFilter);
    if (spaceFilter) threads = threads.filter((t) => t.spacePath === resolve(spaceFilter));
    if (worktreeFilter)
      threads = threads.filter((t) => t.worktree === worktreeFilter);
    if (sessionFilter)
      threads = threads.filter((t) => t.sessionId === sessionFilter);
    sendJson(res, 200, threads);
    return true;
  }
  if (method === "POST" && path === "/threads") {
    return createThreadRoute(ctx, req, res);
  }
  return false;
}

async function createThreadRoute(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const body = await readJsonBody<CreateThreadRequest>(req);
  if (!body || typeof body.body !== "string" || !body.body.trim()) {
    sendJson(res, 400, { error: "body is required" });
    return true;
  }
  const targetLevel = body.file
    ? "file"
    : body.targetLevel === "space"
      ? "space"
      : "repo";
  const spacePath = body.spacePath
    ? resolveSpacePath(ctx, res, body.spacePath)
    : null;
  if (body.spacePath && !spacePath) return true;

  if (targetLevel === "space") {
    if (!spacePath) {
      sendJson(res, 400, { error: "spacePath is required for space comments" });
      return true;
    }
    const thread = await createThread(
      spaceThreadStore(spacePath),
      {
        ...body,
        repo: null,
        worktree: null,
        targetLevel,
        file: null,
        side: null,
        line: null,
        endLine: null,
        anchor: null,
        scope: null,
        sessionId: null,
        snapshotId: null,
      },
      ctx.now(),
    );
    thread.spacePath = spacePath;
    ctx.events.notify(DAEMON_EVENTS.threadChanged);
    sendJson(res, 201, thread);
    return true;
  }

  const resolved = resolveRepoTarget(ctx, res, body.repo ?? undefined, body.worktree ?? null);
  if (!resolved) return true;
  const { repo, treeRoot } = resolved;
  // Bind repo/file comments to the changeset they were filed under: resolve the
  // scope (target spec → base/head + session) server-side, anchor file comments
  // against the scope's base, and persist both so the comment belongs to the
  // branch/scope, not the worktree directory.
  const scope = await resolveScope(
    treeRoot,
    normalizeTarget(body.target),
    body.worktree ?? null,
  );
  const anchor = await buildAnchor(treeRoot, scope.baseSha, body);
  // Record which snapshot (iteration) of the scope the comment was filed against.
  const snapshotId = await snapshotIdForState(treeRoot, scope);
  const store = spacePath ? spaceThreadStore(spacePath) : repo.root;
  const thread = await createThread(
    store,
    { ...body, repo: repo.name, targetLevel, anchor, scope, sessionId: sessionIdForScope(scope), snapshotId },
    ctx.now(),
  );
  if (spacePath) {
    thread.spacePath = spacePath;
    ctx.events.notify(DAEMON_EVENTS.threadChanged);
  }
  sendJson(res, 201, thread);
  return true;
}

/** `POST /threads/:id/{comments,resolve,delete}`. */
async function threadItemRoutes(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (method !== "POST") return false;

  const commentMatch = /^\/threads\/([^/]+)\/comments$/.exec(path);
  if (commentMatch) {
    const id = decodeURIComponent(commentMatch[1]!);
    const body = await readJsonBody<AddCommentRequest>(req);
    if (!body || typeof body.body !== "string" || !body.body.trim()) {
      sendJson(res, 400, { error: "body is required" });
      return true;
    }
    await withThread(res, async () =>
      addComment(await requireThreadStore(ctx, id), id, body, ctx.now()),
    );
    return true;
  }

  const resolveMatch = /^\/threads\/([^/]+)\/resolve$/.exec(path);
  if (resolveMatch) {
    const id = decodeURIComponent(resolveMatch[1]!);
    const body = (await readJsonBody<ResolveThreadRequest>(req)) ?? {};
    await withThread(res, async () =>
      resolveThread(await requireThreadStore(ctx, id), id, body, ctx.now()),
    );
    return true;
  }

  const deleteMatch = /^\/threads\/([^/]+)\/delete$/.exec(path);
  if (deleteMatch) {
    return deleteThreadRoute(ctx, req, res, decodeURIComponent(deleteMatch[1]!));
  }
  return false;
}

async function deleteThreadRoute(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<boolean> {
  const body = (await readJsonBody<DeleteThreadRequest>(req)) ?? {};
  try {
    await deleteThread(await requireThreadStore(ctx, id), id, body, ctx.now());
    sendJson(res, 200, { ok: true });
  } catch (err) {
    if (err instanceof UnknownThreadError) {
      sendJson(res, 404, { error: err.message });
    } else {
      throw err;
    }
  }
  return true;
}

/**
 * `POST /repos/:repo/sessions/archive` — archive or revive a review session.
 * The body's `scope` identifies the review; the server re-derives the session id
 * from it (never trusting a client-supplied id) and refuses a falsy/legacy scope.
 */
async function sessionRoutes(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  const m = /^\/repos\/(.+)\/sessions\/archive$/.exec(path);
  if (!(method === "POST" && m)) return false;
  const repoName = decodeURIComponent(m[1]!);
  const repo = findRepo(ctx.ws, repoName);
  if (!repo) {
    sendJson(res, 404, { error: `unknown repo: ${repoName}` });
    return true;
  }
  const body = await readJsonBody<ArchiveSessionRequest>(req);
  if (!body || !body.scope || typeof body.archived !== "boolean") {
    sendJson(res, 400, { error: "scope and archived are required" });
    return true;
  }
  try {
    // The store is keyed by the repo's PRIMARY root so all worktrees share one
    // log; archiveSession re-derives the session id from the scope and refuses a
    // falsy/legacy scope (the unscoped bucket is structurally un-archivable).
    const result = await archiveSession(repo.root, body, ctx.now());
    // archivedSessions rides on the workspace summary, which the client refetches
    // only on workspaceChanged — the thread-log write alone fires threadChanged.
    ctx.events.notify(DAEMON_EVENTS.workspaceChanged);
    sendJson(res, 200, { ok: true, archived: result });
  } catch (err) {
    if (err instanceof UnscopedSessionError) {
      sendJson(res, 400, { error: err.message });
    } else {
      throw err;
    }
  }
  return true;
}

/** `GET /repos/:repo/diff` and `GET /repos/:repo/refs`. */
async function repoRoutes(
  ctx: RouteContext,
  res: ServerResponse,
  url: URL,
  method: string,
  path: string,
): Promise<boolean> {
  if (method !== "GET") return false;
  const worktree = url.searchParams.get("worktree");

  const diffMatch = /^\/repos\/(.+)\/diff$/.exec(path);
  if (diffMatch) {
    const repoName = decodeURIComponent(diffMatch[1]!);
    const treeRoot = resolveRepoTreeOr404(ctx, res, repoName, worktree);
    if (!treeRoot) return true;
    const target = normalizeTarget(url.searchParams.get("target"));
    const diff = await computeTargetDiff(treeRoot, target);
    // Stamp the resolved scope/session so the client can bind and filter threads
    // to the current review without resolving git refs itself.
    const scope = await resolveScope(treeRoot, target, worktree);
    sendJson(res, 200, {
      ...diff,
      repo: repoName,
      worktree,
      scope,
      sessionId: sessionIdForScope(scope),
      // The live snapshot the client compares each thread's snapshotId against to
      // flag threads filed in an earlier iteration of this scope. Omit (not null)
      // when none can be computed (unborn HEAD), matching the optional field.
      currentSnapshotId: (await snapshotIdForState(treeRoot, scope)) ?? undefined,
    });
    return true;
  }

  const refSearchMatch = /^\/repos\/(.+)\/refs\/search$/.exec(path);
  if (refSearchMatch) {
    const treeRoot = resolveRepoTreeOr404(
      ctx,
      res,
      decodeURIComponent(refSearchMatch[1]!),
      worktree,
    );
    if (!treeRoot) return true;
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit ? Number(rawLimit) : undefined;
    sendJson(
      res,
      200,
      await searchRefs(treeRoot, url.searchParams.get("q") ?? "", limit),
    );
    return true;
  }

  const refsMatch = /^\/repos\/(.+)\/refs$/.exec(path);
  if (refsMatch) {
    const treeRoot = resolveRepoTreeOr404(
      ctx,
      res,
      decodeURIComponent(refsMatch[1]!),
      worktree,
    );
    if (!treeRoot) return true;
    sendJson(res, 200, await listRefs(treeRoot));
    return true;
  }

  const filesMatch = /^\/repos\/(.+)\/files$/.exec(path);
  if (filesMatch) {
    const treeRoot = resolveRepoTreeOr404(
      ctx,
      res,
      decodeURIComponent(filesMatch[1]!),
      worktree,
    );
    if (!treeRoot) return true;
    sendJson(res, 200, await listTrackedFiles(treeRoot));
    return true;
  }
  return false;
}

/**
 * `GET /repos/:repo/file/content?path=&oldPath=&target=&worktree=` — full old/new
 * content for the diff's two sides under a target. Lets the client render
 * expandable collapsed context and the diff library validate without
 * reconstructing the file (which otherwise warns in dev for any normal diff).
 */
async function fileContentRoute(
  ctx: RouteContext,
  res: ServerResponse,
  url: URL,
  method: string,
  path: string,
): Promise<boolean> {
  const m = /^\/repos\/(.+)\/file\/content$/.exec(path);
  if (!(method === "GET" && m)) return false;
  const q = url.searchParams;
  const treeRoot = resolveRepoTreeOr404(
    ctx,
    res,
    decodeURIComponent(m[1]!),
    q.get("worktree"),
  );
  if (!treeRoot) return true;
  const file = q.get("path");
  if (!file) {
    sendJson(res, 400, { error: "path required" });
    return true;
  }
  const target = normalizeTarget(q.get("target"));
  const content = await readTargetFileContent(treeRoot, target, file, q.get("oldPath") || file);
  sendJson(res, 200, content);
  return true;
}

/** `GET /repos/:repo/file?path=&side=&from=&to=` — lines for unfolding context. */
async function fileRoute(
  ctx: RouteContext,
  res: ServerResponse,
  url: URL,
  method: string,
  path: string,
): Promise<boolean> {
  const m = /^\/repos\/(.+)\/file$/.exec(path);
  if (!(method === "GET" && m)) return false;
  const q = url.searchParams;
  const treeRoot = resolveRepoTreeOr404(
    ctx,
    res,
    decodeURIComponent(m[1]!),
    q.get("worktree"),
  );
  if (!treeRoot) return true;
  const file = q.get("path");
  const side = q.get("side") === "old" ? "old" : "new";
  const from = Number(q.get("from"));
  const to = Number(q.get("to"));
  if (!file || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    sendJson(res, 400, { error: "path, from, and to (from<=to, from>=1) required" });
    return true;
  }
  const base = side === "old" ? await resolveWorkBase(treeRoot) : null;
  const all = await readSideLines(treeRoot, file, side, base);
  if (!all) {
    sendJson(res, 404, { error: "file not found or binary" });
    return true;
  }
  // Clamp the span so a huge `to` can't return an enormous payload.
  const lines = all.slice(from - 1, Math.min(to, from - 1 + 2000));
  sendJson(res, 200, { from, lines });
  return true;
}

/** Resolve repo+worktree to a tree root, sending a 404 and returning null on miss. */
function resolveRepoTreeOr404(
  ctx: RouteContext,
  res: ServerResponse,
  repoName: string,
  worktree: string | null,
): string | null {
  const repo = findRepo(ctx.ws, repoName);
  if (!repo) {
    sendJson(res, 404, { error: `unknown repo: ${repoName}` });
    return null;
  }
  const treeRoot = resolveRepoRoot(ctx.ws, repo.name, worktree);
  if (!treeRoot) {
    sendJson(res, 404, { error: `unknown worktree: ${worktree}` });
    return null;
  }
  return treeRoot;
}

/** `POST /open` editor handoff. */
async function editorRoute(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (!(method === "POST" && path === "/open")) return false;
  const body = await readJsonBody<OpenRequest>(req);
  if (!body || !body.file || typeof body.line !== "number" || !body.editor) {
    sendJson(res, 400, { error: "file, line, and editor are required" });
    return true;
  }
  const target = resolveRepoTarget(ctx, res, body.repo, body.worktree ?? null);
  if (!target) return true;
  try {
    await openInEditor(target.treeRoot, body.file, body.line, body.editor);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    // Bad input (unsupported editor, path escaping the repo) is a 400, not a 500.
    if (err instanceof UnknownEditorError || err instanceof PathEscapeError) {
      sendJson(res, 400, { error: err.message });
    } else {
      throw err;
    }
  }
  return true;
}

/** `POST /open-url` opens a web URL in the host browser. */
async function externalUrlRoute(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (!(method === "POST" && path === "/open-url")) return false;
  if (!isLoopback(ctx.host)) {
    sendJson(res, 403, { error: "opening URLs is only allowed on a loopback-bound daemon" });
    return true;
  }
  const body = await readJsonBody<OpenUrlRequest>(req);
  if (!body || typeof body.url !== "string") {
    sendJson(res, 400, { error: "url is required" });
    return true;
  }
  try {
    await openExternalUrl(body.url);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    if (err instanceof UnsupportedUrlError) {
      sendJson(res, 400, { error: err.message });
    } else {
      throw err;
    }
  }
  return true;
}

/**
 * `POST /attachments` (upload, loopback-only) and `GET /attachments/:id` (serve).
 * The body is raw file bytes with the mime in Content-Type and an optional
 * X-Filename header; the response gives back a content-addressed URL to embed.
 */
async function attachmentRoutes(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (method === "POST" && path === "/attachments") {
    return uploadAttachmentRoute(ctx, req, res);
  }
  const m = /^\/attachments\/(.+)$/.exec(path);
  if (method === "GET" && m) {
    return serveAttachmentRoute(res, decodeURIComponent(m[1]!));
  }
  return false;
}

async function uploadAttachmentRoute(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!isLoopback(ctx.host)) {
    // Uploading writes host files; only over loopback, never a shared network.
    sendJson(res, 403, { error: "uploads are only allowed on a loopback-bound daemon" });
    return true;
  }
  let bytes: Buffer;
  try {
    bytes = await readRawBody(req, MAX_ATTACHMENT_BYTES);
  } catch (err) {
    if (!(err instanceof BodyTooLargeError)) throw err;
    sendJson(res, 413, { error: "attachment too large" });
    return true;
  }
  if (bytes.length === 0) {
    sendJson(res, 400, { error: "empty attachment" });
    return true;
  }
  const mime = (req.headers["content-type"] ?? "").split(";")[0]!.trim();
  const filename = decodeHeader(header(req.headers["x-filename"]));
  const { id } = await storeAttachment(bytes, mime, filename);
  sendJson(res, 200, { url: `/attachments/${id}`, name: filename ?? id });
  return true;
}

async function serveAttachmentRoute(
  res: ServerResponse,
  id: string,
): Promise<boolean> {
  if (!isValidAttachmentId(id)) {
    // Reject anything but `<sha>.<ext>` — closes path traversal on the id.
    sendJson(res, 400, { error: "bad attachment id" });
    return true;
  }
  const info = await stat(attachmentPath(id)).catch(() => null);
  if (!info) {
    sendJson(res, 404, { error: "not found" });
    return true;
  }
  const mime = attachmentMime(id);
  // Real raster images may render inline (so <img> embeds work); everything else
  // — including SVG, which can carry script — downloads instead of rendering on a
  // direct hit. <img> requests ignore Content-Disposition, so embeds still work.
  const inline = mime.startsWith("image/") && mime !== "image/svg+xml";
  res.writeHead(200, {
    "content-type": mime,
    "content-length": info.size,
    "content-disposition": inline ? "inline" : "attachment",
    // Defang any uploaded active content (e.g. scripted SVG) on direct hits.
    "content-security-policy": "default-src 'none'; sandbox",
    "x-content-type-options": "nosniff",
  });
  createReadStream(attachmentPath(id)).pipe(res);
  return true;
}

/** The client percent-encodes the filename so non-ASCII survives the header. */
function decodeHeader(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value; // keep raw if it isn't valid percent-encoding
  }
}

/**
 * `GET /fs/list?path=` (folder browser) and `GET /recommendations` (recent
 * Claude/pi project roots). Both read host directories, so they're loopback-only.
 */
async function discoveryRoutes(
  ctx: RouteContext,
  res: ServerResponse,
  url: URL,
  method: string,
  path: string,
): Promise<boolean> {
  if (!(method === "GET" && (path === "/fs/list" || path === "/recommendations"))) {
    return false;
  }
  if (!isLoopback(ctx.host)) {
    sendJson(res, 403, { error: "discovery is only allowed on a loopback-bound daemon" });
    return true;
  }
  if (path === "/recommendations") {
    sendJson(res, 200, await recommendations());
    return true;
  }
  try {
    sendJson(res, 200, await listDir(url.searchParams.get("path") ?? undefined));
  } catch (err) {
    if (err instanceof FsBrowseError) sendJson(res, 400, { error: err.message });
    else throw err;
  }
  return true;
}

/** First value of a possibly-array header, trimmed; undefined if absent/empty. */
function header(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the central store (repo root) that owns a thread id, scanning every
 * repo in the workspace. Throws UnknownThreadError (→ 404 via withThread) when
 * no repo claims it, so mutations carrying only an id route to the right log.
 */
async function requireThreadStore(
  ctx: RouteContext,
  id: string,
): Promise<ThreadStoreRef> {
  const store = await findStoreForThread(ctx.ws, id);
  if (!store) throw new UnknownThreadError(id);
  return store;
}

function resolveSpacePath(
  ctx: RouteContext,
  res: ServerResponse,
  path: string,
): string | null {
  const abs = resolve(path);
  if (!workspacePaths(ctx.ws).includes(abs)) {
    sendJson(res, 400, { error: `unknown space: ${path}` });
    return null;
  }
  return abs;
}

/**
 * Resolve a repo name + worktree to its repo and working-tree root, sending a 400
 * and returning null on bad input. Shared by the create-thread and open routes.
 */
function resolveRepoTarget(
  ctx: RouteContext,
  res: ServerResponse,
  repoName: string | undefined,
  worktree: string | null,
): { repo: DiscoveredRepo; treeRoot: string } | null {
  const repo = repoName ? findRepo(ctx.ws, repoName) : undefined;
  if (!repo) {
    sendJson(res, 400, { error: `unknown repo: ${repoName}` });
    return null;
  }
  const treeRoot = resolveRepoRoot(ctx.ws, repo.name, worktree);
  if (!treeRoot) {
    sendJson(res, 400, { error: `unknown worktree: ${worktree}` });
    return null;
  }
  return { repo, treeRoot };
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

/** Buffer the request body up to `maxBytes`, throwing past the cap. */
async function readRawBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      // Stop reading but leave the socket intact so the 413 response can flush;
      // pausing avoids buffering the rest of an oversize upload.
      req.pause();
      throw new BodyTooLargeError();
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T | null> {
  const raw = (await readRawBody(req, MAX_BODY_BYTES)).toString("utf8");
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Attachments can be images, so allow a larger body than JSON comments. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

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
