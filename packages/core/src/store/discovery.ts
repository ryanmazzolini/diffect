import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { FsListing, RecommendedWorkspace } from "@diffect/shared";
import {
  scanSessionProjects,
  type SessionLogKind,
} from "../workspace-providers/session-log.js";

/** Honour $HOME first so tests can point discovery at a fixture home. */
function homeDir(): string {
  return process.env.HOME || homedir();
}

// ── Directory browser (for the add-workspace picker) ──────────────────────────

export class FsBrowseError extends Error {}

/**
 * List the sub-directories of `requested` (default: home) for an in-app folder
 * picker. Confined to the home subtree via realpath so a symlink can't escape;
 * dotfiles are hidden. Returns directories only — you register a directory as a
 * workspace, not a file.
 */
export async function listDir(requested?: string): Promise<FsListing> {
  const root = await realpath(homeDir());
  // Resolve relatives against home (not the daemon cwd); absolutes pass through.
  const target = await realpath(resolve(root, requested?.trim() || ".")).catch(
    () => null,
  );
  if (!target || !(target === root || target.startsWith(root + sep))) {
    throw new FsBrowseError("path is outside the home directory");
  }
  const dirents = await readdir(target, { withFileTypes: true }).catch(() => {
    throw new FsBrowseError("cannot read directory");
  });
  const entries = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => ({ name: d.name, path: join(target, d.name), isDir: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { path: target, parent: target === root ? null : dirname(target), entries };
}

// ── Recent-session recommendations ────────────────────────────────────────────

interface Source {
  root: string;
  kind: SessionLogKind;
  source: RecommendedWorkspace["source"];
}

export async function recommendations(limit = 20): Promise<RecommendedWorkspace[]> {
  const home = homeDir();
  const sources: Source[] = [
    {
      root: join(home, ".claude", "projects"),
      kind: "claude",
      source: "claude-code",
    },
    {
      root: join(home, ".pi", "agent", "sessions"),
      kind: "pi",
      source: "pi",
    },
  ];
  const found = (
    await Promise.all(
      sources.map(async ({ root, kind, source }) => {
        const projects = await scanSessionProjects(root, kind);
        const recommendations = await Promise.all(
          projects.map(async (project): Promise<RecommendedWorkspace | null> => {
            if (!(await isGitRepo(project.cwd))) return null;
            return {
              path: project.cwd,
              name: basename(project.cwd),
              lastActiveAt: project.lastActiveAt,
              source,
            };
          }),
        );
        return recommendations.filter(
          (recommendation): recommendation is RecommendedWorkspace => recommendation !== null,
        );
      }),
    )
  ).flat();

  // Dedupe by resolved path, keeping the most recently active entry.
  const byPath = new Map<string, RecommendedWorkspace>();
  for (const recommendation of found) {
    const previous = byPath.get(recommendation.path);
    if (!previous || recommendation.lastActiveAt > previous.lastActiveAt) {
      byPath.set(recommendation.path, recommendation);
    }
  }
  return [...byPath.values()]
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, limit);
}

async function isGitRepo(path: string): Promise<boolean> {
  // `.git` is a directory in a normal clone, a file in a linked worktree.
  return !!(await stat(join(path, ".git")).catch(() => null));
}
