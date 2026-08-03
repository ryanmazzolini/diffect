#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { PrDraftUpdateRequest } from "@diffect/shared";
import { computeWorkDiff, resolveCurrentBranch } from "./git/diff.js";
import { gitTry } from "./git/exec.js";
import {
  ReviewService,
  UnknownReviewError,
} from "./reviews/service.js";
import { readPrDraft, updatePrDraft } from "./store/pr-draft.js";
import {
  discoverWorkspace,
  resolveRepoRoot,
  type DiscoveredRepo,
  type Workspace,
} from "./workspace.js";

interface Flags {
  positionals: string[];
  options: Map<string, string>;
  bools: Set<string>;
}

function parseFlags(argv: string[], boolFlags: Set<string>): Flags {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  const bools = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const key = argument.slice(2);
    if (boolFlags.has(key)) bools.add(key);
    else options.set(key, argv[++index] ?? "");
  }
  return { positionals, options, bools };
}

async function workspaceFromCwd(): Promise<Workspace> {
  const top = await gitTry(process.cwd(), ["rev-parse", "--show-toplevel"]);
  return discoverWorkspace(resolve(top ?? process.cwd()));
}

function requireRepo(workspace: Workspace, flags: Flags): DiscoveredRepo {
  const requested = flags.options.get("repo");
  if (requested) {
    const repo = workspace.repos.find((candidate) => candidate.name === requested);
    if (!repo) fail(`unknown repository: ${requested}`);
    return repo;
  }
  if (workspace.repos.length === 1) return workspace.repos[0]!;
  fail(
    `workspace has ${workspace.repos.length} repositories; pass --repo <${workspace.repos
      .map((repo) => repo.name)
      .join("|")}>`,
  );
}

async function resolveTarget(flags: Flags) {
  const workspace = await workspaceFromCwd();
  const repo = requireRepo(workspace, flags);
  const requestedWorktree = flags.options.get("worktree");
  const currentRoot = await realpath(workspace.root);
  const primaryRoot = await realpath(repo.root);
  const resolvedCurrentWorktree = (
    await Promise.all(
      repo.worktrees.map(async (candidate) => ({
        candidate,
        root: await realpath(candidate.root),
      })),
    )
  ).find(({ root }) => root === currentRoot)?.candidate;
  const worktree =
    requestedWorktree !== undefined
      ? requestedWorktree || null
      : resolvedCurrentWorktree && currentRoot !== primaryRoot
        ? resolvedCurrentWorktree.name
        : null;
  const treeRoot = resolveRepoRoot(workspace, repo.name, worktree);
  if (!treeRoot) fail(`unknown worktree: ${worktree ?? "primary"}`);
  return { workspace, repo, worktree, treeRoot };
}

async function commandDiff(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, new Set(["json"]));
  const { repo, worktree, treeRoot } = await resolveTarget(flags);
  const diff = {
    ...(await computeWorkDiff(treeRoot)),
    repo: repo.name,
    worktree,
  };
  if (flags.bools.has("json")) {
    process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
    return 0;
  }
  if (diff.files.length === 0) {
    process.stdout.write("No current changes.\n");
    return 0;
  }
  for (const file of diff.files) {
    process.stdout.write(`${file.status.padEnd(10)} ${file.path}\n`);
  }
  return 0;
}

async function commandReview(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, new Set(["json"]));
  const action = flags.positionals[0];
  const id = flags.positionals[1];
  if (action !== "show" || !id) {
    fail("usage: diffect review show <review-id> [--json]");
  }
  try {
    const service = new ReviewService();
    const review = await service.getReview(id);
    const result = { review, link: service.linkFor(review.id) };
    if (flags.bools.has("json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(`${result.link}\n`);
    for (const thread of review.threads) {
      const location = thread.location;
      process.stdout.write(
        `${thread.id}  ${location.path}:${location.startLine}-${location.endLine}\n`,
      );
      process.stdout.write(`    ${thread.comments[0]?.body ?? ""}\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof UnknownReviewError) fail(error.message);
    throw error;
  }
}

async function commandPr(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, new Set(["json"]));
  const action = flags.positionals[0] ?? "get";
  const { workspace, repo, worktree, treeRoot } = await resolveTarget(flags);
  const scope = {
    workspacePath: workspace.root,
    repo: repo.name,
    repoRoot: repo.root,
    worktree,
    branch: await resolveCurrentBranch(treeRoot),
  };

  if (action === "get") {
    process.stdout.write(`${JSON.stringify(await readPrDraft(scope), null, 2)}\n`);
    return 0;
  }
  if (action === "update") {
    const patch: PrDraftUpdateRequest = {};
    if (flags.options.has("title")) patch.title = flags.options.get("title") ?? "";
    if (flags.options.has("body")) patch.body = flags.options.get("body") ?? "";
    if (patch.title === undefined && patch.body === undefined) {
      fail("--title or --body is required");
    }
    process.stdout.write(
      `${JSON.stringify(
        await updatePrDraft(scope, patch, new Date().toISOString()),
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  fail('usage: diffect pr [get|update] [--repo R] [--worktree W] [--title "…"] [--body "…"]');
}

function fail(message: string): never {
  process.stderr.write(`diffect: ${message}\n`);
  process.exit(1);
}

const USAGE = `diffect — local-first Reviews

Usage:
  diffect diff [--repo R] [--worktree W] [--json]
  diffect review show <review-id> [--json]
  diffect pr [get|update] [--repo R] [--worktree W] [--title "…"] [--body "…"]
`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "diff":
      return commandDiff(rest);
    case "review":
      return commandReview(rest);
    case "pr":
      return commandPr(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`diffect: unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`diffect: ${error?.message ?? error}\n`);
    process.exit(1);
  },
);
