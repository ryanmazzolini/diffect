import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { WorkspaceRepository, WorkspaceSummary } from "@diffect/shared";
import { gitTry } from "./git/exec.js";
import { resolveCurrentBranch } from "./git/diff.js";
import { realpathSafe } from "./path-safe.js";

export interface Workspace {
  /** Absolute workspace root. */
  root: string;
  /** Discovered repos, deduplicated by working-tree root. */
  repos: DiscoveredRepo[];
}

export interface DiscoveredRepo {
  /**
   * URL-safe identifier for the repo, used in API paths and stored on threads.
   * Stable across worktrees of the same repo. Never "." — that would collapse
   * in URL normalization (`/repos/./diff` → `/repos/diff`).
   */
  name: string;
  /** Absolute path to the primary working tree root. */
  root: string;
  /** Git common dir shared by all worktrees of this repo. */
  commonDir: string;
  /** All checkouts of this repo, including the primary one. */
  worktrees: DiscoveredWorktree[];
  /** The registered workspace path this repo was discovered under (set when
   * repos from several workspaces are merged). */
  workspacePath?: string;
}

export interface DiscoveredWorktree {
  /** URL-safe identifier, unique within the repo (the checkout dir basename). */
  name: string;
  /** Absolute path to this checkout. */
  root: string;
}

const MAX_DEPTH = 2;

/**
 * Discover the repo(s) under a workspace path. Two modes:
 *  - the path is itself inside a git working tree → that single repo
 *  - the path is a container dir (ticket/repo-worktrees layout) → every git
 *    working tree found by walking depth 1-2, grouped into repos by the git
 *    common dir so multiple worktrees of one repo render as one repo with an
 *    A/B group.
 */
export async function discoverWorkspace(workspacePath: string): Promise<Workspace> {
  const root = resolve(workspacePath);

  // If the workspace root is itself within a working tree, that's the (single)
  // repo — don't also descend into nested checkouts.
  const topLevel = await gitTry(root, ["rev-parse", "--show-toplevel"]);
  const treeRoots =
    topLevel && resolve(topLevel) === root
      ? [root]
      : await findWorkingTrees(root);

  if (treeRoots.length === 0) {
    throw new Error(
      `No git repository found under ${root}. Diffect reviews a workspace containing at least one git repo.`,
    );
  }

  const repos = await groupIntoRepos(treeRoots);
  return { root, repos };
}

/** Walk the workspace up to MAX_DEPTH looking for git working-tree roots. */
async function findWorkingTrees(root: string): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    // A directory (or .git file, for linked worktrees) marks a working tree.
    if (await isWorkingTree(dir)) {
      const abs = resolve(dir);
      if (!seen.has(abs)) {
        seen.add(abs);
        found.push(abs);
      }
      return; // don't descend into a repo's own subdirectories
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // Skip known-noise dirs, but still descend into other dotted dirs so a
      // repo checked out into e.g. `.config` is discoverable.
      if (e.name === "node_modules" || e.name === ".git" || e.name === ".reviews")
        continue;
      await walk(join(dir, e.name), depth + 1);
    }
  }

  await walk(root, 0);
  return found;
}

async function isWorkingTree(dir: string): Promise<boolean> {
  // `.git` may be a directory (primary) or a file (linked worktree).
  const dotgit = join(dir, ".git");
  try {
    await stat(dotgit);
    return true;
  } catch {
    return false;
  }
}

/** Group working trees into repos keyed by their shared git common dir. */
async function groupIntoRepos(treeRoots: string[]): Promise<DiscoveredRepo[]> {
  const byCommonDir = new Map<string, DiscoveredWorktree[]>();
  const order: string[] = [];

  for (const treeRoot of treeRoots) {
    const commonDir = await gitTry(treeRoot, ["rev-parse", "--git-common-dir"]);
    if (commonDir === null) continue; // not actually a repo
    // git-common-dir is relative for the primary worktree but an absolute,
    // realpath'd path for linked ones, so realpath the resolved key — otherwise a
    // repo under any symlinked path (e.g. macOS /var -> /private/var) splits its
    // worktrees across two keys and they're treated as separate repos.
    const key = realpathSafe(resolve(treeRoot, commonDir));
    if (!byCommonDir.has(key)) {
      byCommonDir.set(key, []);
      order.push(key);
    }
    byCommonDir.get(key)!.push({ name: basename(treeRoot), root: treeRoot });
  }

  const repos = order.map((key) => {
    const discovered = byCommonDir.get(key)!;
    // A linked checkout reports the primary checkout's `.git` directory as its
    // common dir even when the primary was outside the scanned workspace. Keep
    // repository ownership on that primary path and include it as a selectable
    // checkout so the same Review store is used from either entry point.
    const discoveredPrimary = discovered.find(
      (worktree) => realpathSafe(resolve(worktree.root, ".git")) === key,
    );
    const primaryRoot =
      discoveredPrimary?.root ??
      (basename(key) === ".git" ? dirname(key) : discovered[0]!.root);
    const primary =
      discoveredPrimary ?? { name: basename(primaryRoot), root: primaryRoot };
    const worktrees = discovered.some(
      (worktree) => realpathSafe(worktree.root) === realpathSafe(primaryRoot),
    )
      ? discovered
      : [primary, ...discovered];
    return {
      name: basename(primaryRoot),
      root: primaryRoot,
      commonDir: key,
      worktrees,
    };
  });
  return dedupeNames(repos);
}

/**
 * Ensure repo names are unique and URL-safe. Two repos can share a directory
 * basename (e.g. `frontend/api` and `backend/api`); without disambiguation the
 * second is unreachable — findRepo returns the first match and threads would
 * re-anchor against the wrong repo. Collisions get a parent-dir-qualified name,
 * then a numeric suffix, applied in discovery order so names are deterministic.
 */
function dedupeNames(repos: DiscoveredRepo[]): DiscoveredRepo[] {
  const counts = new Map<string, number>();
  for (const r of repos) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);

  const taken = new Set<string>();
  for (const r of repos) {
    if ((counts.get(r.name) ?? 0) <= 1) {
      taken.add(r.name);
      continue;
    }
    const parent = basename(resolve(r.root, ".."));
    let chosen = `${parent}-${r.name}`;
    for (let i = 2; taken.has(chosen); i++) chosen = `${r.name}-${i}`;
    r.name = chosen;
    taken.add(chosen);
  }
  return repos;
}

/**
 * Merge several discovered workspaces into one aggregate view: the union of all
 * their repos, re-deduplicated globally so names stay unique and URL-safe across
 * workspaces. Each aggregate repo is tagged with its source `workspacePath`.
 * Source repo objects are left untouched (clones are deduped) so per-workspace
 * listings keep their own names.
 */
export function mergeWorkspaces(workspaces: Workspace[]): Workspace {
  const tagged = workspaces.flatMap((w) =>
    w.repos.map((r) => ({ ...r, workspacePath: w.root })),
  );
  return { root: workspaces[0]?.root ?? "", repos: dedupeNames(tagged) };
}

/** Look up one repo in the workspace by its name. */
export function findRepo(ws: Workspace, name: string): DiscoveredRepo | undefined {
  return ws.repos.find((r) => r.name === name);
}

/**
 * Resolve a repo + optional worktree to a working-tree root. With no worktree,
 * returns the primary. Used by diff/anchor/thread routing.
 */
export function resolveRepoRoot(
  ws: Workspace,
  repo: string,
  worktree: string | null,
): string | undefined {
  const r = findRepo(ws, repo);
  if (!r) return undefined;
  if (!worktree) return r.root;
  return r.worktrees.find((w) => w.name === worktree)?.root;
}

/** Summarize repository and checkout identity without feedback-derived state. */
export async function summarizeRepos(
  repos: DiscoveredRepo[],
): Promise<WorkspaceRepository[]> {
  return Promise.all(
    repos.map(async (repo) => ({
      name: repo.name,
      root: repo.root,
      worktrees: await Promise.all(
        repo.worktrees.map(async (worktree) => ({
          name: worktree.name,
          root: worktree.root,
          branch: await resolveCurrentBranch(worktree.root),
        })),
      ),
    })),
  );
}

export async function summarizeWorkspace(ws: Workspace): Promise<WorkspaceSummary> {
  return {
    root: ws.root,
    repos: await summarizeRepos(ws.repos),
  };
}
