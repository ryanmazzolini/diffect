import type { Thread } from "@diffect/shared";
import { resolveWorkBase } from "../git/diff.js";
import type { DiscoveredRepo, Workspace } from "../workspace.js";
import { loadThreads, readEvents } from "./event-log.js";
import { refreshAnchors, type RepoLocation } from "./anchors.js";

/**
 * Load and concatenate threads from every repo's central store. The store is
 * keyed by repo root, so a workspace with N repos has N logs; aggregating here
 * keeps the daemon/CLI thread views workspace-wide.
 */
export async function loadAllThreads(ws: Workspace): Promise<Thread[]> {
  const perRepo = await Promise.all(ws.repos.map((r) => loadThreads(r.root)));
  return perRepo.flat();
}

/**
 * Resolve which repo's central store owns a thread id, by scanning each repo's
 * log for the creating event. Used by mutation paths that carry only an id (the
 * CLI reply/resolve/dismiss, and daemon routes without a repo hint). Returns
 * undefined when no repo claims the thread.
 */
export async function findRepoRootForThread(
  ws: Workspace,
  threadId: string,
): Promise<string | undefined> {
  for (const repo of ws.repos) {
    const events = await readEvents(repo.root);
    if (events.some((e) => e.type === "thread.created" && e.id === threadId)) {
      return repo.root;
    }
  }
  return undefined;
}

/** Per-worktree content locations for one repo (worktree name → root+base). */
async function repoLocations(
  repo: DiscoveredRepo,
): Promise<Map<string, RepoLocation>> {
  const locations = new Map<string, RepoLocation>();
  for (const wt of repo.worktrees) {
    const loc: RepoLocation = { root: wt.root, base: await resolveWorkBase(wt.root) };
    if (wt.root === repo.root) locations.set("", loc); // primary (no worktree)
    locations.set(wt.name, loc);
  }
  return locations;
}

/**
 * Load threads and re-anchor each against the current code so callers see
 * up-to-date positions and stale flags. Anchoring is done per repo against the
 * repo it was loaded from — never via the thread's stored repo *name* — so a
 * globally-deduped name shift across workspaces can't mislocate a thread.
 */
export async function loadRefreshedThreads(ws: Workspace): Promise<Thread[]> {
  const out: Thread[] = [];
  for (const repo of ws.repos) {
    const threads = await loadThreads(repo.root);
    if (threads.length === 0) continue;
    const locations = await repoLocations(repo);
    const refreshed = await refreshAnchors(threads, (_repo, worktree) =>
      locations.get(worktree ?? ""),
    );
    // Stamp the CURRENT aggregate name: a thread's stored repo name can go stale
    // when cross-workspace dedup renames a colliding basename, which would break
    // name-based filtering. The store key (repo.root) is the real identity.
    for (const t of refreshed) t.repo = repo.name;
    out.push(...refreshed);
  }
  return out;
}
