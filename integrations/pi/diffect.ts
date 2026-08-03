import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findLocalFile, resolveTrustedCommand } from "./local-files.js";

const BASE_URL = "http://127.0.0.1:7421";
const MAX_OUTPUT = 50_000;

type Command = { command: string; args: string[] };
type ToolContext = { cwd: string };

export default function diffectExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "diffect_open",
    label: "Diffect Open",
    description: "Start or reuse Diffect and return the current Review URL.",
    promptSnippet: "Open the current workspace in Diffect",
    parameters: Type.Object({
      workspace: Type.Optional(
        Type.String({ description: "Workspace path; current Git repository when omitted" }),
      ),
      open: Type.Optional(Type.Boolean({ description: "Also open the URL" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const requested = resolveUserPath(params.workspace ?? ctx.cwd, ctx.cwd);
      const anchor = await gitRoot(pi, requested, signal);
      const workspace = params.workspace ? requested : anchor ?? requested;
      const baseUrl = await ensureDaemon(pi, workspace, signal);
      await registerWorkspace(baseUrl, workspace, signal);
      const location = await locateRepository(baseUrl, anchor, signal);
      const url = location
        ? `${baseUrl}/?repo=${encodeURIComponent(location.repo)}${
            location.worktree
              ? `&worktree=${encodeURIComponent(location.worktree)}`
              : ""
          }`
        : baseUrl;
      if (params.open) openUrl(url, workspace);
      return textResult(url, { url, workspaceRoot: workspace, repoRoot: anchor });
    },
  });

  pi.registerTool({
    name: "diffect_list_feedback",
    label: "Diffect Feedback",
    description: "Read one clean Review exactly by its opaque Review ID.",
    promptSnippet: "Read Diffect feedback for one Review",
    promptGuidelines: [
      "Pass the Review ID from the Diffect link. Exact Review reads do not infer Git scopes or list unrelated feedback.",
    ],
    parameters: Type.Object({
      reviewId: Type.String({ description: "Opaque Review ID, beginning rvw_" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!/^rvw_[a-f0-9]{32}$/.test(params.reviewId)) {
        throw new Error("reviewId must be an opaque rvw_ Review ID");
      }
      return runCli(pi, ctx, ["review", "show", params.reviewId, "--json"], signal);
    },
  });

  pi.registerTool({
    name: "diffect_pr",
    label: "Diffect PR",
    description: "Get or update the local PR Draft packet for a Diffect repository.",
    promptSnippet: "Get or update Diffect's local PR Draft title/body",
    parameters: Type.Object({
      action: Type.Optional(Type.String({ description: "get, update, or copy_body; default get" })),
      title: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      repo: Type.Optional(Type.String()),
      worktree: Type.Optional(Type.String()),
      workspace: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const action = params.action ?? "get";
      const scope: string[] = [];
      if (params.repo) scope.push("--repo", params.repo);
      if (params.worktree) scope.push("--worktree", params.worktree);
      const workspace = resolveUserPath(params.workspace ?? ctx.cwd, ctx.cwd);
      if (action === "get" || action === "copy_body") {
        const result = await runCli(
          pi,
          { cwd: workspace },
          ["pr", "get", "--json", ...scope],
          signal,
        );
        if (action === "copy_body") {
          const stdout = (result.details as { stdout: string }).stdout;
          const body = (JSON.parse(stdout) as { body?: unknown }).body;
          return textResult(typeof body === "string" ? body : "", result.details);
        }
        return result;
      }
      if (action === "update") {
        const args = ["pr", "update", "--json", ...scope];
        if (params.title !== undefined) args.push("--title", params.title);
        if (params.body !== undefined) args.push("--body", params.body);
        if (params.title === undefined && params.body === undefined) {
          throw new Error("title or body is required");
        }
        return runCli(pi, { cwd: workspace }, args, signal);
      }
      throw new Error(`unknown diffect_pr action: ${action}`);
    },
  });
}

async function ensureDaemon(
  pi: ExtensionAPI,
  workspace: string,
  signal?: AbortSignal,
): Promise<string> {
  const configured = process.env.DIFFECT_URL?.trim();
  if (configured) {
    if (await isDiffectd(configured, signal)) return configured;
    throw new Error(`DIFFECT_URL is not a reachable Review daemon: ${configured}`);
  }
  if (await isDiffectd(BASE_URL, signal)) return BASE_URL;

  const daemon = await findDaemon(pi, workspace, signal);
  spawn(
    daemon.command,
    [
      ...daemon.args,
      "--workspace",
      workspace,
      "--host",
      "127.0.0.1",
      "--port",
      "7421",
    ],
    {
      cwd: workspace,
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  ).unref();

  for (let attempt = 0; attempt < 50; attempt++) {
    await sleep(100, signal);
    if (await isDiffectd(BASE_URL, signal)) return BASE_URL;
  }
  throw new Error(
    "diffectd did not start on 127.0.0.1:7421; stop the process using that port or inspect diffectd output",
  );
}

async function isDiffectd(baseUrl: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: unknown; model?: unknown };
    return body.ok === true && body.model === "review";
  } catch {
    return false;
  }
}

async function registerWorkspace(
  baseUrl: string,
  workspace: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: workspace }),
    signal,
  });
  if (!response.ok) throw new Error(await responseError(response));
}

async function locateRepository(
  baseUrl: string,
  anchor: string | null,
  signal?: AbortSignal,
): Promise<{ repo: string; worktree: string | null } | null> {
  const response = await fetch(`${baseUrl}/api/workspace`, { signal });
  if (!response.ok) throw new Error(await responseError(response));
  const workspace = (await response.json()) as {
    repos?: Array<{
      name: string;
      root: string;
      worktrees: Array<{ name: string; root: string }>;
    }>;
  };
  const repos = workspace.repos ?? [];
  if (anchor) {
    const wanted = real(anchor);
    for (const repo of repos) {
      if (real(repo.root) === wanted) return { repo: repo.name, worktree: null };
      const worktree = repo.worktrees.find((candidate) => real(candidate.root) === wanted);
      if (worktree) return { repo: repo.name, worktree: worktree.name };
    }
  }
  return repos.length === 1 ? { repo: repos[0]!.name, worktree: null } : null;
}

async function runCli(
  pi: ExtensionAPI,
  context: ToolContext,
  args: string[],
  signal?: AbortSignal,
) {
  const cli = await findCli(pi, context.cwd, signal);
  const result = await pi.exec(cli.command, [...cli.args, ...args], {
    cwd: context.cwd,
    signal,
    timeout: 30_000,
  });
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `diffect exited ${result.code}`,
    );
  }
  const stdout = result.stdout.trim() || "{}";
  return textResult(truncate(stdout), {
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
  });
}

async function gitRoot(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    signal,
    timeout: 5_000,
  });
  return result.code === 0 && result.stdout.trim()
    ? resolve(result.stdout.trim())
    : null;
}

async function findCli(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<Command> {
  const local = findLocalFile("packages/core/dist/cli.js", fileURLToPath(import.meta.url));
  if (local) return nodeCommand(local);
  const command = await pathCommand(pi, "diffect", cwd, signal);
  if (command) return { command, args: [] };
  throw new Error("diffect CLI not found. Build Diffect or put diffect on PATH.");
}

async function findDaemon(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<Command> {
  const local = findLocalFile(
    "packages/core/dist/daemon-bin.js",
    fileURLToPath(import.meta.url),
  );
  if (local) return nodeCommand(local);
  const command = await pathCommand(pi, "diffectd", cwd, signal);
  if (command) return { command, args: [] };
  throw new Error("diffectd not found. Build Diffect or put diffectd on PATH.");
}

async function pathCommand(
  pi: ExtensionAPI,
  name: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const lookup = homedir();
  const result = await pi.exec("bash", ["-lc", `command -v ${name}`], {
    cwd: lookup,
    signal,
    timeout: 5_000,
  });
  if (result.code !== 0 || !result.stdout.trim()) return null;
  return resolveTrustedCommand(result.stdout.trim(), lookup, cwd);
}

function nodeCommand(file: string): Command {
  return file.endsWith(".ts")
    ? { command: "node", args: ["--experimental-strip-types", file] }
    : { command: "node", args: [file] };
}

function resolveUserPath(path: string, cwd: string): string {
  const expanded =
    path === "~"
      ? homedir()
      : path.startsWith("~/")
        ? join(homedir(), path.slice(2))
        : path;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function openUrl(url: string, cwd: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { cwd, detached: true, stdio: "ignore" }).unref();
  } catch {
    // The URL is still returned for remote/headless environments.
  }
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
    const timer = setTimeout(resolveSleep, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("cancelled"));
      },
      { once: true },
    );
  });
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT
    ? `${text.slice(0, MAX_OUTPUT)}\n\n[truncated at ${MAX_OUTPUT} bytes]`
    : text;
}

function textResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}
