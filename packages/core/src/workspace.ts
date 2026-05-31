import { basename, resolve } from "node:path";
import type { RepoSummary, WorkspaceInfo } from "@diffect/shared";
import { gitTry } from "./git/exec.js";
import { resolveDefaultBranch, resolveWorkBase } from "./git/diff.js";

export interface Workspace {
  /** Absolute workspace root. */
  root: string;
  /** Discovered repos. Slice 1 supports exactly one. */
  repos: DiscoveredRepo[];
}

export interface DiscoveredRepo {
  /**
   * URL-safe identifier for the repo, used in API paths and stored on threads.
   * The repo's directory basename when the workspace root is itself a repo,
   * otherwise the path relative to the workspace root. Never "." — that would
   * collapse in URL normalization (`/repos/./diff` → `/repos/diff`).
   */
  name: string;
  /** Absolute path to the repo's working tree root. */
  root: string;
}

/**
 * Discover the repo(s) under a workspace path. Slice 1 handles the single-repo
 * case: the workspace path is (or is inside) one git working tree. Multi-repo
 * and worktree grouping arrive in Slice 4.
 */
export async function discoverWorkspace(workspacePath: string): Promise<Workspace> {
  const root = resolve(workspacePath);
  const repoRoot = await gitTry(root, ["rev-parse", "--show-toplevel"]);
  if (!repoRoot) {
    throw new Error(
      `No git repository found at ${root}. Diffect reviews a workspace containing at least one git repo.`,
    );
  }
  const absRepoRoot = resolve(repoRoot);
  const name =
    absRepoRoot === root ? basename(absRepoRoot) : relativeName(root, absRepoRoot);
  return {
    root,
    repos: [{ name, root: absRepoRoot }],
  };
}

/** Look up one repo in the workspace by its relative name. */
export function findRepo(ws: Workspace, name: string): DiscoveredRepo | undefined {
  return ws.repos.find((r) => r.name === name);
}

export async function summarizeWorkspace(
  ws: Workspace,
  openThreadCount: number,
): Promise<WorkspaceInfo> {
  const repos: RepoSummary[] = await Promise.all(
    ws.repos.map(async (r) => ({
      name: r.name,
      root: r.root,
      base: await resolveWorkBase(r.root),
      defaultBranch: await resolveDefaultBranch(r.root),
    })),
  );
  return { root: ws.root, repos, openThreadCount };
}

function relativeName(from: string, to: string): string {
  // The repo root is the workspace root or an ancestor in the single-repo case;
  // fall back to its basename rather than a "../.." path.
  const rel = to.startsWith(from) ? to.slice(from.length).replace(/^\//, "") : "";
  return rel || basename(to);
}
