import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_BASE_URL = "http://127.0.0.1:7421";
const DEFAULT_TARGET = "work";
const MAX_OUTPUT = 50_000;

type Command = { command: string; args: string[] };
type RepoLocation = { repo: string; worktree: string | null };

export default function diffectExtension(pi: ExtensionAPI) {
  pi.registerCommand("diffect", {
    description: "Open the current repo in Diffect",
    handler: async (args, ctx) => {
      try {
        const target = args.trim() || DEFAULT_TARGET;
        const { url } = await diffectUrl(pi, ctx.cwd, target);
        await openUrl(pi, ctx.cwd, url);
        ctx.ui.notify(`Diffect: ${url}`, "info");
      } catch (err) {
        ctx.ui.notify(`Diffect failed: ${messageOf(err)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "diffect_open",
    label: "Diffect Open",
    description: "Start/reuse diffectd and return the current repo's Diffect URL.",
    promptSnippet: "Open the current repo in Diffect's local review UI",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Review target, default: work" })),
      open: Type.Optional(Type.Boolean({ description: "Also ask the OS to open the URL" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { url, repoRoot } = await diffectUrl(pi, ctx.cwd, params.target ?? DEFAULT_TARGET, signal);
      if (params.open) await openUrl(pi, ctx.cwd, url, signal);
      return textResult(url, { url, repoRoot });
    },
  });

  pi.registerTool({
    name: "diffect_list_feedback",
    label: "Diffect Feedback",
    description: "List Diffect review feedback as JSON using the local store.",
    promptSnippet: "List open Diffect review feedback before making review fixes",
    promptGuidelines: [
      "Use diffect_list_feedback when the user asks to address Diffect review feedback.",
    ],
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "open, closed, or all; default: open" })),
      repo: Type.Optional(Type.String()),
      worktree: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["list", "--json"];
      if (params.status && params.status !== "all") args.push("--status", params.status);
      if (params.repo) args.push("--repo", params.repo);
      if (params.worktree) args.push("--worktree", params.worktree);
      return runDiffectTool(pi, ctx.cwd, args, signal);
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
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return runDiffectTool(
        pi,
        ctx.cwd,
        ["reply", params.id, "--agent", params.agent ?? "pi", "--body", params.body],
        signal,
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
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return runDiffectTool(
        pi,
        ctx.cwd,
        ["resolve", params.id, "--agent", params.agent ?? "pi", "--summary", params.summary],
        signal,
      );
    },
  });

  pi.registerTool({
    name: "diffect_comment",
    label: "Diffect Comment",
    description: "Create a Diffect review comment on a file line/range as an agent.",
    parameters: Type.Object({
      file: Type.String(),
      line: Type.Number(),
      endLine: Type.Optional(Type.Number()),
      side: Type.Optional(Type.String({ description: "new or old; default: new" })),
      severity: Type.Optional(Type.String({ description: "must-fix, suggestion, nit, or question" })),
      target: Type.Optional(Type.String({ description: "Review target, default: work" })),
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
      return runDiffectTool(pi, ctx.cwd, args, signal);
    },
  });
}

async function diffectUrl(
  pi: ExtensionAPI,
  cwd: string,
  target: string,
  signal?: AbortSignal,
): Promise<{ url: string; repoRoot: string }> {
  const repoRoot = await gitRoot(pi, cwd, signal);
  const baseUrl = await ensureDaemon(pi, repoRoot, signal);
  await registerWorkspace(baseUrl, repoRoot, signal);
  const loc = await locateRepo(baseUrl, repoRoot, signal);
  const q = new URLSearchParams({ repo: loc.repo, target });
  if (loc.worktree) q.set("worktree", loc.worktree);
  return { url: `${baseUrl}/?${q}`, repoRoot };
}

async function gitRoot(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string> {
  const r = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    signal,
    timeout: 5_000,
  });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "not inside a git repository");
  return r.stdout.trim();
}

async function ensureDaemon(
  pi: ExtensionAPI,
  repoRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  const configured = process.env.DIFFECT_URL?.trim();
  if (configured) {
    if (await isDiffectd(configured, signal)) return configured;
    throw new Error(`DIFFECT_URL is not reachable: ${configured}`);
  }

  const marked = await liveMarkedDaemon(signal);
  if (marked) return marked;

  if (await openDiffectApp(pi, repoRoot, undefined, signal)) {
    for (let i = 0; i < 80; i++) {
      await sleep(100, signal);
      const url = await liveMarkedDaemon(signal);
      if (url) return url;
    }
  }

  if (await isDiffectd(DEFAULT_BASE_URL, signal)) return DEFAULT_BASE_URL;

  const daemon = await findDaemon(pi, repoRoot, signal);
  spawn(daemon.command, [...daemon.args, "--workspace", repoRoot, "--host", "127.0.0.1", "--port", "0"], {
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

async function registerWorkspace(baseUrl: string, repoRoot: string, signal?: AbortSignal) {
  const res = await fetch(`${baseUrl}/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: repoRoot }),
    signal,
  });
  if (!res.ok) throw new Error(await responseError(res));
}

async function locateRepo(
  baseUrl: string,
  repoRoot: string,
  signal?: AbortSignal,
): Promise<RepoLocation> {
  const res = await fetch(`${baseUrl}/workspace`, { signal });
  if (!res.ok) throw new Error(await responseError(res));
  const workspace = (await res.json()) as {
    repos?: Array<{ name: string; root: string; worktrees?: Array<{ name: string; root: string }> }>;
  };
  const wanted = real(repoRoot);
  for (const repo of workspace.repos ?? []) {
    if (real(repo.root) === wanted) return { repo: repo.name, worktree: null };
    for (const wt of repo.worktrees ?? []) {
      if (real(wt.root) === wanted) return { repo: repo.name, worktree: wt.name };
    }
  }
  throw new Error(`diffectd does not list repo ${repoRoot}`);
}

async function runDiffectTool(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
) {
  const repoRoot = await gitRoot(pi, cwd, signal);
  const cli = await findCli(pi, repoRoot, signal);
  const r = await pi.exec(cli.command, [...cli.args, ...args], {
    cwd: repoRoot,
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
