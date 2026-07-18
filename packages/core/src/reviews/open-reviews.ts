import type {
  CommitSummary,
  OpenReviewAvailability,
  OpenReviewSummary,
  ReviewEndpointSummary,
  ReviewScope,
  Thread,
} from "@diffect/shared";
import { commitSummaryForRef, isNamedRef } from "../git/refs.js";
import { normalizeTarget } from "../git/target.js";
import type { DiscoveredRepo } from "../workspace.js";
import {
  loadThreads,
  repoThreadStore,
  spaceThreadStore,
} from "./event-log.js";
import {
  rangeSemanticsForScope,
  resolveScope,
  sessionIdForScope,
} from "./scope.js";

export interface OpenReviewDiscoveryInput {
  workspaceRoot: string;
  repo: DiscoveredRepo;
  /** Current aggregate route name plus any source-workspace name persisted earlier. */
  storedRepoNames: ReadonlySet<string>;
}

interface ReviewGroup {
  sessionId: string;
  latest: Thread & { scope: ReviewScope; sessionId: string };
  openThreadCount: number;
}

type CommitCache = Map<string, Promise<CommitSummary | null>>;
type NamedRefCache = Map<string, Promise<boolean>>;
const ENRICHMENT_CONCURRENCY = 8;

/**
 * Discover exact open reviews for one active workspace and repo. The active
 * space store wins duplicate thread ids before status/grouping, then only that
 * repo's legacy store participates; registered sibling workspaces never do.
 */
export async function discoverOpenReviews({
  workspaceRoot,
  repo,
  storedRepoNames,
}: OpenReviewDiscoveryInput): Promise<OpenReviewSummary[]> {
  const [spaceThreads, repoThreads] = await Promise.all([
    loadThreads(spaceThreadStore(workspaceRoot)),
    loadThreads(repoThreadStore(repo.root)),
  ]);
  const selectedSpaceThreads = spaceThreads.filter(
    (thread) => thread.repo !== null && storedRepoNames.has(thread.repo),
  );
  const seen = new Set(selectedSpaceThreads.map((thread) => thread.id));
  const deduplicated = [
    ...selectedSpaceThreads,
    ...repoThreads.filter((thread) => !seen.has(thread.id)),
  ];

  const groups = new Map<string, ReviewGroup>();
  for (const thread of deduplicated) {
    if (
      thread.status !== "open" ||
      thread.scope === null ||
      thread.sessionId === null
    ) {
      continue;
    }
    const scoped = thread as Thread & { scope: ReviewScope; sessionId: string };
    const group = groups.get(thread.sessionId);
    if (!group) {
      groups.set(thread.sessionId, {
        sessionId: thread.sessionId,
        latest: scoped,
        openThreadCount: 1,
      });
      continue;
    }
    group.openThreadCount += 1;
    if (thread.updatedAt > group.latest.updatedAt) group.latest = scoped;
  }

  const commitCache: CommitCache = new Map();
  const namedRefCache: NamedRefCache = new Map();
  const summaries = await mapWithConcurrency(
    [...groups.values()],
    ENRICHMENT_CONCURRENCY,
    (group) => summarizeGroup(repo, group, commitCache, namedRefCache),
  );
  return summaries.sort((a, b) => b.latestActivity.localeCompare(a.latestActivity));
}

async function summarizeGroup(
  repo: DiscoveredRepo,
  group: ReviewGroup,
  commitCache: CommitCache,
  namedRefCache: NamedRefCache,
): Promise<OpenReviewSummary> {
  const { scope, worktree, updatedAt } = group.latest;
  const treeRoot = resolvePersistedCheckout(repo, worktree);
  const [from, to, availability] = await Promise.all([
    summarizeEndpoint(
      treeRoot,
      scope.baseRef,
      "from",
      scope.kind,
      commitCache,
      namedRefCache,
    ),
    summarizeEndpoint(
      treeRoot,
      scope.headRef,
      "to",
      scope.kind,
      commitCache,
      namedRefCache,
    ),
    resolveAvailability(group.sessionId, scope, worktree, treeRoot, commitCache),
  ]);
  return {
    sessionId: group.sessionId,
    scope,
    worktree,
    rangeSemantics: rangeSemanticsForScope(scope),
    availability,
    openThreadCount: group.openThreadCount,
    latestActivity: updatedAt,
    from,
    to,
  };
}

function resolvePersistedCheckout(
  repo: DiscoveredRepo,
  worktree: string | null,
): string | null {
  if (worktree === null) return repo.root;
  return repo.worktrees.find((candidate) => candidate.name === worktree)?.root ?? null;
}

async function resolveAvailability(
  sessionId: string,
  scope: ReviewScope,
  worktree: string | null,
  treeRoot: string | null,
  commitCache: CommitCache,
): Promise<OpenReviewAvailability> {
  if (treeRoot === null) {
    return { state: "missing-checkout", worktree: worktree! };
  }

  const missing = await missingPersistedRefs(treeRoot, scope, commitCache);
  if (missing.length > 0) return { state: "missing-ref", endpoints: missing };

  const target = normalizeTarget(scope.target);
  const currentScope = await resolveScope(treeRoot, target, worktree);
  return sessionIdForScope(currentScope, worktree) === sessionId
    ? { state: "available" }
    : { state: "scope-changed" };
}

async function missingPersistedRefs(
  treeRoot: string,
  scope: ReviewScope,
  commitCache: CommitCache,
): Promise<("from" | "to")[]> {
  const persisted = [
    { side: "from" as const, ref: scope.baseRef },
    { side: "to" as const, ref: scope.headRef },
  ].filter(({ ref }) => ref !== "index" && ref !== "worktree");
  const resolved = await Promise.all(
    persisted.map(async ({ side, ref }) => ({
      side,
      commit: await cachedCommit(
        treeRoot,
        ref.startsWith("wt:") ? "HEAD" : ref,
        commitCache,
      ),
    })),
  );
  return resolved
    .filter((entry) => entry.commit === null)
    .map((entry) => entry.side);
}

async function summarizeEndpoint(
  treeRoot: string | null,
  persistedLabel: string,
  side: "from" | "to",
  scopeKind: ReviewScope["kind"],
  commitCache: CommitCache,
  namedRefCache: NamedRefCache,
): Promise<ReviewEndpointSummary> {
  if (persistedLabel === "index" || persistedLabel === "worktree") {
    return {
      kind: "local",
      label: persistedLabel === "index" ? "Index" : "Working tree",
      sha: null,
      shortSha: null,
      subject: localEndpointSubject(persistedLabel, side, scopeKind),
      committer: null,
      committedAt: null,
    };
  }

  const resolutionRef = persistedLabel.startsWith("wt:") ? "HEAD" : persistedLabel;
  const label = persistedLabel.startsWith("wt:") ? "HEAD" : persistedLabel;
  const [commit, namedRef] = treeRoot
    ? await Promise.all([
        cachedCommit(treeRoot, resolutionRef, commitCache),
        cachedNamedRef(treeRoot, resolutionRef, namedRefCache),
      ])
    : [null, true];
  return {
    kind: commit && !namedRef ? "commit" : "ref",
    label,
    sha: commit?.sha ?? null,
    shortSha: commit?.shortSha ?? null,
    subject: commit?.subject ?? null,
    committer: commit?.committer ?? null,
    committedAt: commit?.committedAt ?? null,
  };
}

function localEndpointSubject(
  label: "index" | "worktree",
  side: "from" | "to",
  scopeKind: ReviewScope["kind"],
): string {
  if (label === "index" && side === "to" && scopeKind === "staged") {
    return "Staged changes";
  }
  if (label === "worktree") return "Working tree changes";
  return "Index";
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
}

function cachedNamedRef(
  treeRoot: string,
  ref: string,
  cache: NamedRefCache,
): Promise<boolean> {
  const key = JSON.stringify([treeRoot, ref]);
  let pending = cache.get(key);
  if (!pending) {
    pending = isNamedRef(treeRoot, ref);
    cache.set(key, pending);
  }
  return pending;
}

function cachedCommit(
  treeRoot: string,
  ref: string,
  cache: CommitCache,
): Promise<CommitSummary | null> {
  const key = JSON.stringify([treeRoot, ref]);
  let pending = cache.get(key);
  if (!pending) {
    pending = commitSummaryForRef(treeRoot, ref);
    cache.set(key, pending);
  }
  return pending;
}
