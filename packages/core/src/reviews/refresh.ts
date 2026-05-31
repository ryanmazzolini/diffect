import type { Thread } from "@diffect/shared";
import { resolveWorkBase } from "../git/diff.js";
import type { Workspace } from "../workspace.js";
import { loadThreads } from "./event-log.js";
import { refreshAnchors, type RepoLocation } from "./anchors.js";

/**
 * Load threads from the event log and re-anchor each against the current code,
 * so callers see up-to-date positions and stale flags. Repo bases are resolved
 * once per workspace load. Shared by the daemon and the CLI.
 */
export async function loadRefreshedThreads(ws: Workspace): Promise<Thread[]> {
  const threads = await loadThreads(ws.root);
  if (threads.length === 0) return threads;

  const locations = new Map<string, RepoLocation>();
  for (const repo of ws.repos) {
    locations.set(repo.name, { root: repo.root, base: await resolveWorkBase(repo.root) });
  }
  return refreshAnchors(threads, (repo) => locations.get(repo));
}
