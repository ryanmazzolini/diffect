#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Author, Severity, Side, Thread, ThreadStatus } from "@diffect/shared";
import {
  addComment,
  createThread,
  dismissThread,
  resolveThread,
  UnknownThreadError,
} from "./reviews/event-log.js";
import { loadRefreshedThreads } from "./reviews/refresh.js";
import { buildAnchor } from "./reviews/anchors.js";
import { resolveWorkBase } from "./git/diff.js";
import { computeTargetDiff, normalizeTarget } from "./git/target.js";
import { discoverWorkspace, resolveRepoRoot } from "./workspace.js";
import { gitTry } from "./git/exec.js";

// --- shared helpers --------------------------------------------------------

/**
 * Resolve the workspace root the CLI operates on. Walk up from cwd looking for
 * an existing `.reviews/` directory (the canonical store); if none exists yet,
 * fall back to the git working-tree root so the first write lands beside the
 * code under review.
 */
async function resolveWorkspaceRoot(start: string): Promise<string> {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(resolve(dir, ".reviews"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const top = await gitTry(start, ["rev-parse", "--show-toplevel"]);
  return top ? resolve(top) : resolve(start);
}

interface Flags {
  positionals: string[];
  options: Map<string, string>;
  bools: Set<string>;
}

/** Minimal flag parser: `--key value`, `--bool`, and bare positionals. */
function parseFlags(argv: string[], boolFlags: Set<string>): Flags {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (boolFlags.has(key)) {
        bools.add(key);
      } else {
        options.set(key, argv[++i] ?? "");
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, options, bools };
}

function authorFrom(flags: Flags): Author {
  const agent = flags.options.get("agent");
  return agent ? { type: "agent", name: agent } : { type: "user" };
}

function now(): string {
  return new Date().toISOString();
}

function fail(message: string): never {
  process.stderr.write(`diffect: ${message}\n`);
  process.exit(1);
}

/** Parse a 1-based line number, failing on non-integers (e.g. `--line abc`). */
function positiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    fail(`${flag} must be a positive integer, got "${value}"`);
  }
  return n;
}

function printThread(t: Thread): void {
  process.stdout.write(JSON.stringify(t, null, 2) + "\n");
}

/**
 * Resolve the target repo from --repo. Defaults to the sole repo in a
 * single-repo workspace; in a multi-repo workspace requires --repo rather than
 * silently picking one (which would mis-route a comment to the wrong repo).
 */
function requireRepo(
  ws: { repos: { name: string }[] },
  flags: Flags,
): { name: string } {
  const requested = flags.options.get("repo");
  if (requested) {
    const repo = ws.repos.find((r) => r.name === requested);
    if (!repo) fail(`unknown repo: ${requested}`);
    return repo;
  }
  if (ws.repos.length === 1) return ws.repos[0]!;
  fail(
    `workspace has ${ws.repos.length} repos; pass --repo <${ws.repos
      .map((r) => r.name)
      .join("|")}>`,
  );
}

// --- commands --------------------------------------------------------------

async function cmdList(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, new Set(["json"]));
  const status = flags.options.get("status") as ThreadStatus | undefined;
  const repoFilter = flags.options.get("repo");
  const worktreeFilter = flags.options.get("worktree");
  const root = await resolveWorkspaceRoot(process.cwd());
  const ws = await discoverWorkspace(root);
  let threads = await loadRefreshedThreads(ws);
  if (status) threads = threads.filter((t) => t.status === status);
  if (repoFilter) threads = threads.filter((t) => t.repo === repoFilter);
  if (worktreeFilter) threads = threads.filter((t) => t.worktree === worktreeFilter);

  if (flags.bools.has("json")) {
    process.stdout.write(JSON.stringify(threads, null, 2) + "\n");
    return 0;
  }
  if (threads.length === 0) {
    process.stdout.write("No threads.\n");
    return 0;
  }
  for (const t of threads) {
    const loc = t.file ? `${t.file}:${t.line ?? "?"}` : "(general)";
    const sev = t.severity ? `[${t.severity}] ` : "";
    const stale = t.anchorState === "stale" ? " (stale)" : "";
    const first = t.comments[0]?.body.split("\n")[0] ?? "";
    process.stdout.write(
      `${t.id}  ${t.status.padEnd(9)} ${sev}${loc}${stale}\n    ${first}\n`,
    );
  }
  return 0;
}

async function cmdDiff(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, new Set(["json"]));
  const worktree = flags.options.get("worktree") ?? null;
  const root = await resolveWorkspaceRoot(process.cwd());
  const ws = await discoverWorkspace(root);
  const repo = requireRepo(ws, flags);
  const treeRoot = resolveRepoRoot(ws, repo.name, worktree);
  if (!treeRoot) fail(`unknown worktree: ${worktree}`);
  const target = normalizeTarget(flags.options.get("target"));
  const diff = await computeTargetDiff(treeRoot, target);

  if (flags.bools.has("json")) {
    process.stdout.write(
      JSON.stringify({ ...diff, repo: repo.name, worktree }, null, 2) + "\n",
    );
    return 0;
  }
  if (diff.files.length === 0) {
    process.stdout.write(`No changes in the ${target.spec} target.\n`);
    return 0;
  }
  for (const f of diff.files) {
    process.stdout.write(`${f.status.padEnd(10)} ${f.path}\n`);
  }
  return 0;
}

async function cmdComment(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, new Set());
  const file = flags.options.get("file");
  const lineStr = flags.options.get("line");
  const body = flags.options.get("body");
  if (!file) fail("--file is required");
  if (!lineStr) fail("--line is required");
  if (!body) fail("--body is required");
  const root = await resolveWorkspaceRoot(process.cwd());
  const ws = await discoverWorkspace(root);
  const repo = requireRepo(ws, flags);
  const worktree = flags.options.get("worktree") ?? null;
  const treeRoot = resolveRepoRoot(ws, repo.name, worktree);
  if (!treeRoot) fail(`unknown worktree: ${worktree}`);
  const side = (flags.options.get("side") as Side) ?? "new";
  const line = positiveInt(lineStr, "--line");
  const endLine = flags.options.has("end-line")
    ? positiveInt(flags.options.get("end-line")!, "--end-line")
    : null;
  // Anchor against the file content at creation so the thread can survive edits.
  const base = await resolveWorkBase(treeRoot);
  const anchor = await buildAnchor(treeRoot, base, { file, side, line, endLine });
  const thread = await createThread(
    root,
    {
      repo: repo.name,
      worktree,
      file,
      side,
      line,
      endLine,
      severity: (flags.options.get("severity") as Severity) ?? null,
      anchor,
      author: authorFrom(flags),
      body,
    },
    now(),
  );
  printThread(thread);
  return 0;
}

async function cmdGeneral(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, new Set());
  const body = flags.options.get("body");
  if (!body) fail("--body is required");
  const root = await resolveWorkspaceRoot(process.cwd());
  const repoName =
    flags.options.get("repo") ?? (await discoverWorkspace(root)).repos[0]?.name;
  if (!repoName) fail("could not determine repo; pass --repo");
  const thread = await createThread(
    root,
    {
      repo: repoName,
      worktree: flags.options.get("worktree") ?? null,
      file: null,
      side: null,
      line: null,
      author: authorFrom(flags),
      body,
    },
    now(),
  );
  printThread(thread);
  return 0;
}

async function cmdReply(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, new Set());
  const id = flags.positionals[0];
  const body = flags.options.get("body");
  if (!id) fail('usage: diffect reply <thread-id> --body "…"');
  if (!body) fail("--body is required");
  const root = await resolveWorkspaceRoot(process.cwd());
  await mutate(() => addComment(root, id, { author: authorFrom(flags), body }, now()));
  return 0;
}

async function cmdResolve(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, new Set());
  const id = flags.positionals[0];
  if (!id) fail('usage: diffect resolve <thread-id> [--summary "…"]');
  const root = await resolveWorkspaceRoot(process.cwd());
  await mutate(() =>
    resolveThread(
      root,
      id,
      { author: authorFrom(flags), summary: flags.options.get("summary") ?? null },
      now(),
    ),
  );
  return 0;
}

async function cmdDismiss(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, new Set());
  const id = flags.positionals[0];
  if (!id) fail('usage: diffect dismiss <thread-id> [--reason "…"]');
  const root = await resolveWorkspaceRoot(process.cwd());
  await mutate(() =>
    dismissThread(
      root,
      id,
      { author: authorFrom(flags), reason: flags.options.get("reason") ?? null },
      now(),
    ),
  );
  return 0;
}

async function mutate(op: () => Promise<Thread>): Promise<void> {
  try {
    printThread(await op());
  } catch (err) {
    if (err instanceof UnknownThreadError) fail(err.message);
    throw err;
  }
}

const USAGE = `diffect — local-first code review

Usage:
  diffect list    [--status open|resolved|dismissed] [--repo R] [--worktree W] [--json]
  diffect diff    [--repo R] [--worktree W] [--target work|staged|unstaged|<ref>|<a>..<b>] [--json]
  diffect comment [--repo R] [--worktree W] --file F --line N [--end-line M] [--side new|old]
                  [--severity must-fix|suggestion|nit|question] [--agent NAME] --body "…"
  diffect general [--repo R] [--worktree W] [--agent NAME] --body "…"
  diffect reply   <thread-id> [--agent NAME] --body "…"
  diffect resolve <thread-id> [--summary "…"] [--agent NAME]
  diffect dismiss <thread-id> [--reason "…"]  [--agent NAME]

The CLI reads and writes .reviews/ directly and works whether or not diffectd
is running. Use --agent NAME to author a thread or reply as an agent. --repo
defaults to the single repo in the workspace; --target defaults to work.
`;

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "list":
      return cmdList(rest);
    case "diff":
      return cmdDiff(rest);
    case "comment":
      return cmdComment(rest);
    case "general":
      return cmdGeneral(rest);
    case "reply":
      return cmdReply(rest);
    case "resolve":
      return cmdResolve(rest);
    case "dismiss":
      return cmdDismiss(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`diffect: unknown command "${cmd}"\n\n${USAGE}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`diffect: ${err?.message ?? err}\n`);
    process.exit(1);
  },
);
