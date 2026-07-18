import type { Thread, ThreadCreatedEvent, ThreadEvent } from "@diffect/shared";
import { resolveWorkBase } from "../git/diff.js";
import type { DiscoveredRepo, Workspace } from "../workspace.js";
import {
  loadThreads,
  readEvents,
  repoThreadStore,
  spaceThreadStore,
  type ThreadStoreRef,
} from "./event-log.js";
import { refreshAnchors, type RepoLocation } from "./anchors.js";

/**
 * Load and concatenate threads from every repo's central store. The store is
 * keyed by repo root, so a workspace with N repos has N logs; aggregating here
 * keeps the daemon/CLI thread views workspace-wide.
 */
export async function loadAllThreads(ws: Workspace): Promise<Thread[]> {
  return loadRefreshedThreads(ws);
}

export function workspacePaths(ws: Workspace): string[] {
  return [...new Set([ws.root, ...ws.repos.map((r) => r.workspacePath ?? ws.root)])];
}

/**
 * Find scoped threads whose immutable creation event stored `sessionId`.
 * Canonical replay intentionally replaces that API-visible id, so legacy lookup
 * consults the source events without rewriting or exposing migration metadata.
 */
export async function findThreadKeysByStoredSession(
  ws: Workspace,
  sessionId: string,
): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const path of workspacePaths(ws)) {
    for (const event of await readEvents(spaceThreadStore(path))) {
      if (isStoredSessionMatch(event, sessionId)) {
        keys.add(storedSessionThreadKey("space", path, event.id));
      }
    }
  }
  for (const repo of ws.repos) {
    for (const event of await readEvents(repoThreadStore(repo.root))) {
      if (isStoredSessionMatch(event, sessionId)) {
        keys.add(storedSessionThreadKey("repo", repo.name, event.id));
      }
    }
  }
  return keys;
}

/** Match a flattened API thread back to the exact store that supplied it. */
export function threadMatchesStoredSession(
  thread: Thread,
  keys: Set<string>,
): boolean {
  return thread.spacePath
    ? keys.has(storedSessionThreadKey("space", thread.spacePath, thread.id))
    : thread.repo !== null &&
        keys.has(storedSessionThreadKey("repo", thread.repo, thread.id));
}

function isStoredSessionMatch(
  event: ThreadEvent,
  sessionId: string,
): event is ThreadCreatedEvent {
  return (
    event.type === "thread.created" &&
    !!event.scope &&
    event.sessionId === sessionId
  );
}

function storedSessionThreadKey(
  storeKind: "repo" | "space",
  storeIdentity: string,
  threadId: string,
): string {
  return JSON.stringify([storeKind, storeIdentity, threadId]);
}

/**
 * Resolve which central store owns a thread id, scanning space stores first and
 * then legacy per-repo stores. Used by mutation paths that carry only an id.
 */
export async function findStoreForThread(
  ws: Workspace,
  threadId: string,
): Promise<ThreadStoreRef | undefined> {
  for (const path of workspacePaths(ws)) {
    const store = spaceThreadStore(path);
    const events = await readEvents(store);
    if (events.some((e) => e.type === "thread.created" && e.id === threadId)) {
      return store;
    }
  }
  for (const repo of ws.repos) {
    const store = repoThreadStore(repo.root);
    const events = await readEvents(store);
    if (events.some((e) => e.type === "thread.created" && e.id === threadId)) {
      return store;
    }
  }
  return undefined;
}

/** Back-compat for callers that still expect only repo-owned threads. */
export async function findRepoRootForThread(
  ws: Workspace,
  threadId: string,
): Promise<string | undefined> {
  const store = await findStoreForThread(ws, threadId);
  return typeof store === "string" ? store : store?.kind === "repo" ? store.root : undefined;
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
  const locationsByRepo = new Map<string, Map<string, RepoLocation>>();
  for (const repo of ws.repos) {
    locationsByRepo.set(repo.name, await repoLocations(repo));
  }

  for (const path of workspacePaths(ws)) {
    const threads = await loadThreads(spaceThreadStore(path));
    if (threads.length === 0) continue;
    const refreshed = await refreshAnchors(threads, (repo, worktree) =>
      locationsByRepo.get(repo)?.get(worktree ?? ""),
    );
    for (const t of refreshed) t.spacePath = path;
    out.push(...refreshed);
  }

  for (const repo of ws.repos) {
    const threads = await loadThreads(repoThreadStore(repo.root));
    if (threads.length === 0) continue;
    const locations = locationsByRepo.get(repo.name)!;
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
