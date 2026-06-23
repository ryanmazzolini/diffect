import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_BASE_URL = "http://127.0.0.1:7421";
const DEFAULT_TARGET = "work";
const MAX_OUTPUT = 50_000;
const WORKSPACE_ENTRY = "diffect-workspace";
const MAX_WORKSPACE_CHOICES = 12;

type Command = { command: string; args: string[] };
type RepoLocation = { repo: string; worktree: string | null };
type ReviewMode = "feedback" | "proactive";
type ReviewWorkspace = { workspaceRoot: string; anchorRoot: string | null };
type WorkspaceCandidate = ReviewWorkspace & { dirty: boolean; score: number; sources: Set<string> };
type WorkspaceResolveOptions = { forcePicker?: boolean; interactive?: boolean; save?: boolean };
type SessionLike = {
  sessionManager?: {
    getBranch?: () => unknown[];
    getEntries?: () => unknown[];
  };
};
type CwdContext = SessionLike & {
  cwd: string;
  ui?: { select?: (title: string, choices: string[]) => Promise<string | undefined> };
};

export default function diffectExtension(pi: ExtensionAPI) {
  pi.registerCommand("diffect", {
    description: "Open the current Diffect workspace",
    handler: async (args, ctx) => {
      try {
        const parsed = parseCommandArgs(args, ctx.cwd);
        const { url, workspaceRoot } = await diffectUrl(pi, ctx, parsed.target, parsed.workspace, undefined, {
          interactive: true,
          save: true,
        });
        await openUrl(pi, workspaceRoot, url);
        ctx.ui.notify(`Diffect: ${url}`, "info");
      } catch (err) {
        ctx.ui.notify(`Diffect failed: ${messageOf(err)}`, "error");
      }
    },
  });

  pi.registerCommand("diffect-space", {
    description: "Choose this session's Diffect workspace",
    handler: async (_args, ctx) => {
      try {
        const workspace = await resolveReviewWorkspace(pi, ctx, undefined, undefined, {
          forcePicker: true,
          interactive: true,
          save: true,
        });
        ctx.ui.notify(`Diffect workspace: ${shortPath(workspace.workspaceRoot)}`, "info");
      } catch (err) {
        ctx.ui.notify(`Diffect workspace failed: ${messageOf(err)}`, "error");
      }
    },
  });

  pi.registerCommand("diffect-review", {
    description: "Ask the agent to review Diffect feedback",
    handler: async (args, ctx) => {
      try {
        const parsed = parseReviewCommandArgs(args, ctx.cwd);
        const { workspaceRoot } = await resolveReviewWorkspace(pi, ctx, parsed.workspace, undefined, {
          interactive: true,
          save: true,
        });
        pi.sendUserMessage(diffectReviewPrompt(parsed.mode, workspaceRoot));
      } catch (err) {
        ctx.ui.notify(`Diffect review failed: ${messageOf(err)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "diffect_open",
    label: "Diffect Open",
    description: "Start/reuse diffectd and return the current workspace's Diffect URL.",
    promptSnippet: "Open the current workspace in Diffect's local review UI",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Review target, default: work" })),
      workspace: Type.Optional(Type.String({ description: "Workspace/space path; inferred when omitted" })),
      open: Type.Optional(Type.Boolean({ description: "Also ask the OS to open the URL" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { url, workspaceRoot, repoRoot } = await diffectUrl(
        pi,
        ctx,
        params.target ?? DEFAULT_TARGET,
        params.workspace,
        signal,
      );
      if (params.open) await openUrl(pi, workspaceRoot, url, signal);
      return textResult(url, { url, workspaceRoot, repoRoot });
    },
  });

  pi.registerTool({
    name: "diffect_list_feedback",
    label: "Diffect Feedback",
    description: "List Diffect review feedback as JSON using the local store.",
    promptSnippet: "List open Diffect review feedback before making review fixes",
    promptGuidelines: [
      "Use diffect_list_feedback when the user asks to address Diffect review feedback, comments, or threads.",
    ],
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "open, closed, or all; default: open" })),
      repo: Type.Optional(Type.String()),
      worktree: Type.Optional(Type.String()),
      workspace: Type.Optional(Type.String({ description: "Workspace/space path; inferred when omitted" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["list", "--json"];
      if (params.status && params.status !== "all") args.push("--status", params.status);
      if (params.repo) args.push("--repo", params.repo);
      if (params.worktree) args.push("--worktree", params.worktree);
      return runDiffectTool(pi, ctx, args, signal, params.workspace);
    },
  });

  pi.registerTool({
    name: "diffect_reply",
    label: "Diffect Reply",
    description: "Reply to a Diffect review thread/comment as an agent.",
    parameters: Type.Object({
      id: Type.String({ description: "Diffect thread id" }),
      body: Type.String({ description: "Reply body" }),
      agent: Type.Optional(Type.String({ description: "Agent author name; default: pi" })),
      workspace: Type.Optional(Type.String({ description: "Workspace/space path; inferred when omitted" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return runDiffectTool(
        pi,
        ctx,
        ["reply", params.id, "--agent", params.agent ?? "pi", "--body", params.body],
        signal,
        params.workspace,
      );
    },
  });

  pi.registerTool({
    name: "diffect_resolve",
    label: "Diffect Resolve",
    description: "Resolve a Diffect review thread/comment as an agent.",
    parameters: Type.Object({
      id: Type.String({ description: "Diffect thread id" }),
      summary: Type.String({ description: "What changed / why it is resolved" }),
      agent: Type.Optional(Type.String({ description: "Agent author name; default: pi" })),
      workspace: Type.Optional(Type.String({ description: "Workspace/space path; inferred when omitted" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return runDiffectTool(
        pi,
        ctx,
        ["resolve", params.id, "--agent", params.agent ?? "pi", "--summary", params.summary],
        signal,
        params.workspace,
      );
    },
  });

  pi.registerTool({
    name: "diffect_comment",
    label: "Diffect Comment",
    description: "Create a Diffect review comment on a file line/range as an agent.",
    promptSnippet: "Create a Diffect review comment on a file line/range",
    promptGuidelines: [
      "Use diffect_comment for proactive Diffect review comments.",
    ],
    parameters: Type.Object({
      file: Type.String(),
      line: Type.Number(),
      endLine: Type.Optional(Type.Number()),
      side: Type.Optional(Type.String({ description: "new or old; default: new" })),
      severity: Type.Optional(Type.String({ description: "must-fix, suggestion, nit, or question" })),
      target: Type.Optional(Type.String({ description: "Review target, default: work" })),
      repo: Type.Optional(Type.String()),
      worktree: Type.Optional(Type.String()),
      workspace: Type.Optional(Type.String({ description: "Workspace/space path; inferred when omitted" })),
      body: Type.String(),
      agent: Type.Optional(Type.String({ description: "Agent author name; default: pi" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = [
        "comment",
        "--file",
        params.file,
        "--line",
        String(params.line),
        "--side",
        params.side ?? "new",
        "--target",
        params.target ?? DEFAULT_TARGET,
        "--agent",
        params.agent ?? "pi",
        "--body",
        params.body,
      ];
      if (params.endLine !== undefined) args.push("--end-line", String(params.endLine));
      if (params.severity) args.push("--severity", params.severity);
      if (params.repo) args.push("--repo", params.repo);
      if (params.worktree) args.push("--worktree", params.worktree);
      return runDiffectTool(pi, ctx, args, signal, params.workspace);
    },
  });
}

async function diffectUrl(
  pi: ExtensionAPI,
  ctx: CwdContext,
  target: string,
  explicitWorkspace?: string,
  signal?: AbortSignal,
  options?: WorkspaceResolveOptions,
): Promise<{ url: string; workspaceRoot: string; repoRoot: string | null }> {
  const { workspaceRoot, anchorRoot } = await resolveReviewWorkspace(
    pi,
    ctx,
    explicitWorkspace,
    signal,
    options,
  );
  const baseUrl = await ensureDaemon(pi, workspaceRoot, signal);
  await registerWorkspace(baseUrl, workspaceRoot, signal);
  const loc = await locateRepo(baseUrl, workspaceRoot, anchorRoot, signal);
  const q = new URLSearchParams({ repo: loc.repo, target });
  if (loc.worktree) q.set("worktree", loc.worktree);
  return { url: `${baseUrl}/?${q}`, workspaceRoot, repoRoot: anchorRoot };
}

function parseCommandArgs(raw: string, cwd: string): { target: string; workspace?: string } {
  const tokens = splitArgs(raw.trim());
  if (tokens[0] === "--workspace" || tokens[0] === "-w") {
    return { workspace: tokens[1], target: tokens.slice(2).join(" ") || DEFAULT_TARGET };
  }
  if (tokens[0] && existsSync(resolveUserPath(tokens[0], cwd))) {
    return { workspace: tokens[0], target: tokens.slice(1).join(" ") || DEFAULT_TARGET };
  }
  return { target: raw.trim() || DEFAULT_TARGET };
}

function splitArgs(raw: string): string[] {
  return raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
}

function parseReviewCommandArgs(raw: string, cwd: string): { mode: ReviewMode; workspace?: string } {
  const tokens = splitArgs(raw.trim());
  let mode: ReviewMode = "feedback";
  if (["proactive", "comment", "comments", "review"].includes(tokens[0] ?? "")) {
    mode = "proactive";
    tokens.shift();
  } else if (["feedback", "fix", "fixes"].includes(tokens[0] ?? "")) {
    tokens.shift();
  }
  if (tokens[0] === "--workspace" || tokens[0] === "-w") return { mode, workspace: tokens[1] };
  if (tokens[0] && existsSync(resolveUserPath(tokens[0], cwd))) return { mode, workspace: tokens[0] };
  return { mode };
}

function diffectReviewPrompt(mode: ReviewMode, workspaceRoot: string): string {
  const workspace = JSON.stringify(workspaceRoot);
  if (mode === "proactive") {
    return `Review the Diffect workspace at ${workspaceRoot}.\n\nInspect the current changes. Do not edit files. Create concise diffect_comment comments for must-fix issues only, passing workspace: ${workspace}. If there are no must-fix issues, say so.`;
  }
  return `Review open Diffect feedback for workspace ${workspaceRoot}.\n\nFirst call diffect_list_feedback with status: "open" and workspace: ${workspace}. Summarize the open comments/threads, then apply the smallest safe fixes. Verify before using diffect_reply or diffect_resolve, and only resolve threads you actually addressed.`;
}

async function resolveReviewWorkspace(
  pi: ExtensionAPI,
  ctx: CwdContext,
  explicitWorkspace?: string,
  signal?: AbortSignal,
  options: WorkspaceResolveOptions = {},
): Promise<ReviewWorkspace> {
  if (explicitWorkspace) {
    const workspace = await workspaceFromPath(pi, resolveUserPath(explicitWorkspace, ctx.cwd), signal);
    if (!workspace) throw new Error(`No git repo or Diffect workspace found at ${explicitWorkspace}.`);
    if (options.save) saveWorkspace(pi, workspace);
    return workspace;
  }

  const saved = options.forcePicker ? null : await savedWorkspace(pi, ctx, signal);
  if (saved) return saved;

  const candidates = await workspaceCandidates(pi, ctx, signal);
  if (candidates.length === 0) throw new Error(`No git repo or Diffect workspace found from this session or ${ctx.cwd}.`);

  const workspace = options.interactive && (options.forcePicker || candidates.length > 1)
    ? await pickWorkspace(ctx, candidates)
    : candidates[0]!;
  if (options.save) saveWorkspace(pi, workspace);
  return workspace;
}

async function workspaceCandidates(pi: ExtensionAPI, ctx: CwdContext, signal?: AbortSignal): Promise<WorkspaceCandidate[]> {
  const byRoot = new Map<string, WorkspaceCandidate>();
  const saved = latestSavedWorkspace(ctx);
  const paths = sessionPathCandidates(ctx).map((path, index) => ({ path, source: "session", score: 1000 - index }));
  if (saved) paths.push({ path: saved.anchorRoot ?? saved.path, source: "saved", score: 900 });
  paths.push({ path: ctx.cwd, source: "current directory", score: 0 });

  for (const candidate of paths) {
    const workspace = await workspaceFromPath(pi, resolveUserPath(candidate.path, ctx.cwd), signal);
    if (!workspace) continue;

    const key = real(workspace.workspaceRoot);
    const dirty = await workspaceDirty(pi, workspace, signal);
    const score = candidate.score + (dirty ? 200 : 0);
    const existing = byRoot.get(key);
    if (existing) {
      existing.dirty ||= dirty;
      existing.sources.add(candidate.source);
      if (score > existing.score) {
        existing.score = score;
        existing.anchorRoot = workspace.anchorRoot;
      }
    } else {
      byRoot.set(key, { ...workspace, dirty, score, sources: new Set([candidate.source]) });
    }
  }

  return [...byRoot.values()].sort((a, b) => b.score - a.score || a.workspaceRoot.localeCompare(b.workspaceRoot));
}

async function savedWorkspace(pi: ExtensionAPI, ctx: CwdContext, signal?: AbortSignal): Promise<ReviewWorkspace | null> {
  const saved = latestSavedWorkspace(ctx);
  if (!saved) return null;
  const workspace = (await workspaceFromPath(pi, saved.anchorRoot ?? saved.path, signal))
    ?? (await workspaceFromPath(pi, saved.path, signal));
  return workspace && real(workspace.workspaceRoot) === real(saved.path) ? workspace : null;
}

function latestSavedWorkspace(ctx: SessionLike): { path: string; anchorRoot: string | null } | null {
  for (const entry of safeSessionEntries(ctx).slice().reverse()) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== WORKSPACE_ENTRY || !isRecord(entry.data)) continue;
    if (typeof entry.data.path === "string") {
      return {
        path: entry.data.path,
        anchorRoot: typeof entry.data.anchorRoot === "string" ? entry.data.anchorRoot : null,
      };
    }
  }
  return null;
}

function saveWorkspace(pi: ExtensionAPI, workspace: ReviewWorkspace) {
  pi.appendEntry(WORKSPACE_ENTRY, { path: workspace.workspaceRoot, anchorRoot: workspace.anchorRoot });
}

async function pickWorkspace(ctx: CwdContext, candidates: WorkspaceCandidate[]): Promise<ReviewWorkspace> {
  if (!ctx.ui?.select) throw new Error("Multiple Diffect workspaces found. Run /diffect-space to choose one.");
  const choices = candidates.slice(0, MAX_WORKSPACE_CHOICES).map(formatWorkspaceChoice);
  const selected = await ctx.ui.select("Choose Diffect workspace", choices);
  const index = selected ? choices.indexOf(selected) : -1;
  if (index < 0) throw new Error("Diffect workspace selection cancelled.");
  return candidates[index]!;
}

function formatWorkspaceChoice(candidate: WorkspaceCandidate, index: number): string {
  const anchor = candidate.anchorRoot && real(candidate.anchorRoot) !== real(candidate.workspaceRoot)
    ? ` · ${basename(candidate.anchorRoot)}`
    : "";
  const dirty = candidate.dirty ? " · dirty" : "";
  return `${index + 1}. ${shortPath(candidate.workspaceRoot)}${anchor}${dirty} · ${[...candidate.sources].join(", ")}`;
}

async function workspaceDirty(pi: ExtensionAPI, workspace: ReviewWorkspace, signal?: AbortSignal): Promise<boolean> {
  const dir = workspace.anchorRoot ?? (await firstWorkingTree(workspace.workspaceRoot));
  if (!dir) return false;
  const r = await pi.exec("git", ["status", "--porcelain"], { cwd: dir, signal, timeout: 5_000 });
  return r.code === 0 && r.stdout.trim().length > 0;
}

async function workspaceFromPath(
  pi: ExtensionAPI,
  path: string,
  signal?: AbortSignal,
): Promise<ReviewWorkspace | null> {
  const dir = await existingDirectory(path);
  if (!dir) return null;

  const repoRoot = await gitTopLevel(pi, dir, signal);
  if (repoRoot) {
    const parent = dirname(repoRoot);
    // ticket-worktree layout: .../worktrees/<ticket>/<repo>
    if (basename(dirname(parent)) === "worktrees" && (await firstWorkingTree(parent))) {
      return { workspaceRoot: parent, anchorRoot: repoRoot };
    }
    return { workspaceRoot: repoRoot, anchorRoot: repoRoot };
  }

  return (await firstWorkingTree(dir)) ? { workspaceRoot: dir, anchorRoot: null } : null;
}

async function existingDirectory(path: string): Promise<string | null> {
  const info = await stat(path).catch(() => null);
  if (!info) return null;
  return info.isDirectory() ? path : dirname(path);
}

async function gitTopLevel(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string | null> {
  const r = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    signal,
    timeout: 5_000,
  });
  return r.code === 0 && r.stdout.trim() ? resolve(r.stdout.trim()) : null;
}

async function firstWorkingTree(root: string): Promise<string | null> {
  async function walk(dir: string, depth: number): Promise<string | null> {
    if (depth > 2) return null;
    if (await isWorkingTree(dir)) return resolve(dir);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name === ".git" || e.name === ".reviews") continue;
      const found = await walk(join(dir, e.name), depth + 1);
      if (found) return found;
    }
    return null;
  }

  return walk(root, 0);
}

async function isWorkingTree(dir: string): Promise<boolean> {
  return Boolean(await stat(join(dir, ".git")).catch(() => null));
}

function sessionPathCandidates(ctx: SessionLike): string[] {
  const paths: string[] = [];
  for (const entry of safeSessionEntries(ctx).slice(-80).reverse()) {
    paths.push(...extractPaths(JSON.stringify(entry)));
  }
  return [...new Set(paths)];
}

function safeSessionEntries(ctx: SessionLike): unknown[] {
  try {
    return ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
  } catch {
    return [];
  }
}

function extractPaths(text: string): string[] {
  return (text.match(/(?:~\/|\/)[^\s"'`<>),;]+/g) ?? [])
    .map((p) => p.replace(/[.!?:}\]]+$/, ""))
    .filter(Boolean);
}

function resolveUserPath(path: string, cwd: string): string {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function shortPath(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function ensureDaemon(
  pi: ExtensionAPI,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  const configured = process.env.DIFFECT_URL?.trim();
  if (configured) {
    if (await isDiffectd(configured, signal)) return configured;
    throw new Error(`DIFFECT_URL is not reachable: ${configured}`);
  }

  const marked = await liveMarkedDaemon(signal);
  if (marked) return marked;

  if (await openDiffectApp(pi, workspaceRoot, undefined, signal)) {
    for (let i = 0; i < 80; i++) {
      await sleep(100, signal);
      const url = await liveMarkedDaemon(signal);
      if (url) return url;
    }
  }

  if (await isDiffectd(DEFAULT_BASE_URL, signal)) return DEFAULT_BASE_URL;

  const daemon = await findDaemon(pi, workspaceRoot, signal);
  spawn(daemon.command, [...daemon.args, "--workspace", workspaceRoot, "--host", "127.0.0.1", "--port", "0"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  }).unref();

  for (let i = 0; i < 40; i++) {
    await sleep(100, signal);
    const url = await liveMarkedDaemon(signal);
    if (url) return url;
  }
  throw new Error("diffectd did not become ready");
}

async function isDiffectd(baseUrl: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/workspace`, { signal });
    if (!res.ok) return false;
    const json = (await res.json()) as { repos?: unknown };
    return Array.isArray(json.repos);
  } catch {
    return false;
  }
}

async function registerWorkspace(baseUrl: string, workspaceRoot: string, signal?: AbortSignal) {
  const res = await fetch(`${baseUrl}/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: workspaceRoot }),
    signal,
  });
  if (!res.ok) throw new Error(await responseError(res));
}

async function locateRepo(
  baseUrl: string,
  workspaceRoot: string,
  anchorRoot: string | null,
  signal?: AbortSignal,
): Promise<RepoLocation> {
  const res = await fetch(`${baseUrl}/workspaces`, { signal });
  if (!res.ok) throw new Error(await responseError(res));
  const entries = (await res.json()) as Array<{
    path: string;
    repos?: Array<{ name: string; root: string; worktrees?: Array<{ name: string; root: string }> }>;
  }>;
  const wantedWorkspace = real(workspaceRoot);
  const entry = entries.find((e) => real(e.path) === wantedWorkspace);
  const repos = entry?.repos ?? [];
  if (anchorRoot) {
    const wanted = real(anchorRoot);
    for (const repo of repos) {
      if (real(repo.root) === wanted) return { repo: repo.name, worktree: null };
      for (const wt of repo.worktrees ?? []) {
        if (real(wt.root) === wanted) return { repo: repo.name, worktree: wt.name };
      }
    }
  }
  const first = repos[0];
  if (first) return { repo: first.name, worktree: null };
  throw new Error(`diffectd does not list workspace ${workspaceRoot}`);
}

async function runDiffectTool(
  pi: ExtensionAPI,
  ctx: CwdContext,
  args: string[],
  signal?: AbortSignal,
  explicitWorkspace?: string,
) {
  const { workspaceRoot } = await resolveReviewWorkspace(pi, ctx, explicitWorkspace, signal);
  const cli = await findCli(pi, workspaceRoot, signal);
  const r = await pi.exec(cli.command, [...cli.args, ...args], {
    cwd: workspaceRoot,
    signal,
    timeout: 30_000,
  });
  if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || `diffect exited ${r.code}`);
  return textResult(truncate(r.stdout.trim() || "{}"), { stdout: r.stdout, stderr: r.stderr, code: r.code });
}

async function findCli(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<Command> {
  const local = localFile("packages/core/dist/cli.js");
  if (local) return nodeCommand(local);
  const pathCli = await pathCommand(pi, "diffect", cwd, signal);
  if (pathCli) return { command: pathCli, args: [] };
  throw new Error("diffect CLI not found. Build Diffect or put `diffect` on PATH.");
}

async function findDaemon(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<Command> {
  const local = localFile("packages/core/dist/daemon-bin.js");
  if (local) return nodeCommand(local);
  const pathDaemon = await pathCommand(pi, "diffectd", cwd, signal);
  if (pathDaemon) return { command: pathDaemon, args: [] };
  throw new Error("diffectd not found. Build Diffect or put `diffectd` on PATH.");
}

async function pathCommand(
  pi: ExtensionAPI,
  name: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const r = await pi.exec("bash", ["-lc", `command -v ${name}`], { cwd, signal, timeout: 5_000 });
  return r.code === 0 ? r.stdout.trim() || null : null;
}

function localFile(relativePath: string): string | null {
  for (const root of candidateRoots()) {
    const p = resolve(root, relativePath);
    if (existsSync(p)) return p;
  }
  return null;
}

function* candidateRoots(): Generator<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  yield* ancestors(here);
  yield* ancestors(process.cwd());
}

function* ancestors(start: string): Generator<string> {
  let dir = resolve(start);
  while (true) {
    yield dir;
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function nodeCommand(file: string): Command {
  // pi itself may be a Bun/SEA executable; use the user's Node for JS files.
  return file.endsWith(".ts")
    ? { command: "node", args: ["--experimental-strip-types", file] }
    : { command: "node", args: [file] };
}

async function liveMarkedDaemon(signal?: AbortSignal): Promise<string | null> {
  const marker = await readDaemonMarker();
  return marker && (await isDiffectd(marker.url, signal)) ? marker.url : null;
}

async function readDaemonMarker(): Promise<{ url: string } | null> {
  try {
    const parsed = JSON.parse(await readFile(daemonMarkerPath(), "utf8")) as { url?: unknown };
    return typeof parsed.url === "string" ? { url: parsed.url } : null;
  } catch {
    return null;
  }
}

function daemonMarkerPath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "diffect", "daemon.json");
}

async function openDiffectApp(
  pi: ExtensionAPI,
  cwd: string,
  url?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const args = url ? [url] : [];
  const envPath = process.env.DIFFECT_APP_PATH?.trim();
  const candidates = [
    envPath && existsSync(envPath) ? envPath : null,
    localFile("packages/desktop/src-tauri/target/debug/diffect-desktop"),
    localFile("packages/desktop/src-tauri/target/debug/diffect-desktop.exe"),
    localFile("packages/desktop/src-tauri/target/release/diffect-desktop"),
    localFile("packages/desktop/src-tauri/target/release/diffect-desktop.exe"),
    await pathCommand(pi, "diffect-desktop", cwd, signal),
  ].filter((v): v is string => Boolean(v));

  for (const command of candidates) {
    if (spawnDetached(command, args, cwd)) return true;
  }

  if (process.platform === "darwin") {
    for (const openArgs of diffectAppOpenArgs(url)) {
      const r = await pi.exec("open", openArgs, { cwd, signal, timeout: 5_000 });
      if (r.code === 0) return true;
    }
  }
  return false;
}

async function openUrl(
  pi: ExtensionAPI,
  cwd: string,
  url: string,
  signal?: AbortSignal,
): Promise<void> {
  if (await openDiffectApp(pi, cwd, url, signal)) return;

  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // URL is still returned/notified; remote shells often have no opener.
  }
}

function spawnDetached(command: string, args: string[], cwd: string): boolean {
  try {
    spawn(command, args, { cwd, detached: true, stdio: "ignore", env: process.env }).unref();
    return true;
  } catch {
    return false;
  }
}

function diffectAppOpenArgs(url?: string): string[][] {
  const suffix = url ? ["--args", url] : [];
  const app = process.env.DIFFECT_APP?.trim();
  return [
    ...(app ? [["-a", app, ...suffix]] : []),
    ["-b", "app.diffect.desktop", ...suffix],
    ["-a", "Diffect", ...suffix],
  ];
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    const t = setTimeout(resolveSleep, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("cancelled"));
      },
      { once: true },
    );
  });
}

async function responseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT
    ? `${text.slice(0, MAX_OUTPUT)}\n\n[truncated at ${MAX_OUTPUT} bytes]`
    : text;
}

function textResult(text: string, details: unknown) {
  return { content: [{ type: "text", text }], details };
}
