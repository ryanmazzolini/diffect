import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  THREAD_SCHEMA_VERSION,
  type OpenReviewSummary,
  type ReviewScope,
  type ThreadEvent,
} from "@diffect/shared";
import { createServer } from "../src/daemon.js";
import { git } from "../src/git/exec.js";
import { normalizeTarget } from "../src/git/target.js";
import { resolveScope, sessionIdForScope } from "../src/reviews/scope.js";
import { spaceThreadsLogPath, threadsLogPath } from "../src/store/paths.js";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "diffect-open-reviews-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function initRepo(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await writeFile(join(root, "f.txt"), "base\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base commit"]);
  await git(root, ["checkout", "-b", "feature"]);
  await writeFile(join(root, "f.txt"), "feature\n");
  await git(root, ["commit", "-am", "feature commit"]);
  await git(root, ["checkout", "main"]);
}

function created(
  id: string,
  ts: string,
  repo: string,
  scope: ReviewScope,
  worktree: string | null = null,
): ThreadEvent {
  return {
    v: THREAD_SCHEMA_VERSION,
    type: "thread.created",
    id,
    ts,
    repo,
    worktree,
    file: "f.txt",
    side: "new",
    line: 1,
    endLine: null,
    anchor: null,
    severity: null,
    scope,
    sessionId: "sess_persisted_alias",
    author: { type: "user" },
    body: id,
  };
}

function resolved(thread: string, ts: string): ThreadEvent {
  return {
    v: THREAD_SCHEMA_VERSION,
    type: "thread.resolved",
    thread,
    ts,
    author: { type: "user" },
  };
}

async function writeEvents(path: string, events: ThreadEvent[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("open review discovery", () => {
  it("deduplicates, groups, enriches, and preserves degraded exact selections", async () => {
    const workspace = scratch;
    const repo = join(workspace, "repo");
    await initRepo(repo);
    await git(repo, ["branch", "deadbeef", "main"]);

    const direct = await resolveScope(repo, normalizeTarget("main..feature"), null);
    const mergeBase = await resolveScope(repo, normalizeTarget("main...feature"), null);
    const staged = await resolveScope(repo, normalizeTarget("staged"), null);
    const unstaged = await resolveScope(repo, normalizeTarget("unstaged"), null);
    const baseSha = (await git(repo, ["rev-parse", "main"])).stdout.trim();
    const abbreviatedBase = baseSha.slice(0, 4);
    const commitRange = await resolveScope(
      repo,
      normalizeTarget(`${abbreviatedBase}..feature`),
      null,
    );
    const hexBranchRange = await resolveScope(
      repo,
      normalizeTarget("deadbeef..feature"),
      null,
    );
    const missingRef: ReviewScope = {
      target: "missing..feature",
      kind: "range",
      baseRef: "missing",
      headRef: "feature",
      baseSha: null,
      branch: "main",
    };
    const missingWorkBase: ReviewScope = {
      target: "work",
      kind: "work",
      baseRef: "deleted-default",
      headRef: "main",
      baseSha: null,
      branch: "main",
    };
    const removedCheckout: ReviewScope = {
      target: "main..feature",
      kind: "range",
      baseRef: "main",
      headRef: "feature",
      baseSha,
      branch: "feature",
    };
    const changedCheckout: ReviewScope = {
      target: "main",
      kind: "ref",
      baseRef: "main",
      headRef: "feature",
      baseSha,
      branch: "feature",
    };

    await writeEvents(threadsLogPath(repo), [
      created("th_space_wins", "2026-07-18T09:00:00.000Z", "repo", direct),
      created("th_closed_space_wins", "2026-07-18T09:01:00.000Z", "repo", direct),
      created("th_direct", "2026-07-18T09:02:00.000Z", "repo", direct),
      created("th_merge", "2026-07-18T09:03:00.000Z", "repo", mergeBase),
      created("th_commit", "2026-07-18T09:03:30.000Z", "repo", commitRange),
      created("th_hex_branch", "2026-07-18T09:03:45.000Z", "repo", hexBranchRange),
      created("th_staged", "2026-07-18T09:04:00.000Z", "repo", staged),
      created("th_missing", "2026-07-18T09:05:00.000Z", "repo", missingRef),
      created("th_missing_work", "2026-07-18T09:05:30.000Z", "repo", missingWorkBase),
      created(
        "th_removed_checkout",
        "2026-07-18T09:06:00.000Z",
        "repo",
        removedCheckout,
        "removed-checkout",
      ),
      created("th_scope_changed", "2026-07-18T09:07:00.000Z", "repo", changedCheckout),
      created("th_closed_only", "2026-07-18T09:08:00.000Z", "repo", unstaged),
      resolved("th_closed_only", "2026-07-18T09:09:00.000Z"),
    ]);
    await writeEvents(spaceThreadsLogPath(workspace), [
      created("th_space_wins", "2026-07-18T10:00:00.000Z", "repo", direct),
      created("th_closed_space_wins", "2026-07-18T10:01:00.000Z", "repo", direct),
      resolved("th_closed_space_wins", "2026-07-18T10:02:00.000Z"),
      created("th_other_repo", "2026-07-18T10:03:00.000Z", "other", direct),
    ]);

    const server = await createServer({ workspacePath: workspace });
    const base = await listen(server);
    try {
      const response = await fetch(
        `${base}/open-reviews?workspace=${encodeURIComponent(workspace)}&repo=repo`,
      );
      expect(response.status).toBe(200);
      const reviews = (await response.json()) as OpenReviewSummary[];
      expect(reviews).toHaveLength(9);
      expect(reviews.map((review) => review.latestActivity)).toEqual([
        "2026-07-18T10:00:00.000Z",
        "2026-07-18T09:07:00.000Z",
        "2026-07-18T09:06:00.000Z",
        "2026-07-18T09:05:30.000Z",
        "2026-07-18T09:05:00.000Z",
        "2026-07-18T09:04:00.000Z",
        "2026-07-18T09:03:45.000Z",
        "2026-07-18T09:03:30.000Z",
        "2026-07-18T09:03:00.000Z",
      ]);

      const directReview = reviews.find(
        (review) => review.sessionId === sessionIdForScope(direct, null),
      )!;
      expect(directReview).toMatchObject({
        scope: direct,
        worktree: null,
        rangeSemantics: "direct",
        availability: { state: "available" },
        openThreadCount: 2,
        latestActivity: "2026-07-18T10:00:00.000Z",
        from: {
          kind: "ref",
          label: "main",
          subject: "base commit",
          committer: "Test User",
        },
        to: {
          kind: "ref",
          label: "feature",
          subject: "feature commit",
          committer: "Test User",
        },
      });
      expect(directReview.from.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(directReview.from.shortSha).toMatch(/^[0-9a-f]+$/);
      expect(directReview.from.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const mergeReview = reviews.find(
        (review) => review.sessionId === sessionIdForScope(mergeBase, null),
      )!;
      expect(mergeReview.rangeSemantics).toBe("merge-base");
      expect(mergeReview.openThreadCount).toBe(1);

      const commitReview = reviews.find(
        (review) => review.scope.target === `${abbreviatedBase}..feature`,
      )!;
      expect(commitReview.from).toMatchObject({
        kind: "commit",
        label: abbreviatedBase,
        sha: baseSha,
        subject: "base commit",
      });
      const hexBranchReview = reviews.find(
        (review) => review.scope.target === "deadbeef..feature",
      )!;
      expect(hexBranchReview.from).toMatchObject({
        kind: "ref",
        label: "deadbeef",
        sha: baseSha,
      });

      const stagedReview = reviews.find((review) => review.scope.kind === "staged")!;
      expect(stagedReview).toMatchObject({
        availability: { state: "available" },
        from: {
          kind: "ref",
          label: "HEAD",
          subject: "base commit",
        },
        to: {
          kind: "local",
          label: "Index",
          subject: "Staged changes",
          sha: null,
        },
      });

      const missingReview = reviews.find(
        (review) => review.scope.target === "missing..feature",
      )!;
      expect(missingReview.availability).toEqual({
        state: "missing-ref",
        endpoints: ["from"],
      });
      expect(missingReview.from).toMatchObject({ label: "missing", sha: null });
      expect(
        reviews.find((review) => review.scope.target === "work")?.availability,
      ).toEqual({ state: "missing-ref", endpoints: ["from"] });
      expect(
        reviews.find((review) => review.worktree === "removed-checkout")
          ?.availability,
      ).toEqual({ state: "missing-checkout", worktree: "removed-checkout" });
      expect(
        reviews.find((review) => review.scope.target === "main")?.availability,
      ).toEqual({ state: "scope-changed" });
      expect(reviews.some((review) => review.scope.kind === "unstaged")).toBe(false);

      for (const review of reviews.filter(
        (candidate) => candidate.availability.state === "available",
      )) {
        const query = new URLSearchParams({ target: review.scope.target });
        if (review.worktree) query.set("worktree", review.worktree);
        const diff = await (
          await fetch(`${base}/repos/repo/diff?${query}`)
        ).json();
        expect(diff.sessionId).toBe(review.sessionId);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("isolates registered workspaces and accepts a source repo name stored before aggregate renaming", async () => {
    const workspaceA = join(scratch, "team-a", "repo");
    const workspaceB = join(scratch, "team-b", "repo");
    await initRepo(workspaceA);
    await initRepo(workspaceB);
    const scopeA = await resolveScope(
      workspaceA,
      normalizeTarget("main..feature"),
      null,
    );
    const scopeB = await resolveScope(
      workspaceB,
      normalizeTarget("main..feature"),
      null,
    );
    await writeEvents(spaceThreadsLogPath(workspaceA), [
      created("th_a", "2026-07-18T11:00:00.000Z", "repo", scopeA),
    ]);
    await writeEvents(spaceThreadsLogPath(workspaceB), [
      created("th_b", "2026-07-18T12:00:00.000Z", "repo", scopeB),
    ]);
    await writeEvents(threadsLogPath(workspaceB), [
      created("th_b_repo", "2026-07-18T12:01:00.000Z", "repo", scopeB),
    ]);

    const server = await createServer({ workspacePath: workspaceA });
    const base = await listen(server);
    try {
      const added = await fetch(`${base}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: workspaceB }),
      });
      expect(added.status).toBe(200);
      const infoA = await (
        await fetch(`${base}/workspace?workspace=${encodeURIComponent(workspaceA)}`)
      ).json();
      const infoB = await (
        await fetch(`${base}/workspace?workspace=${encodeURIComponent(workspaceB)}`)
      ).json();
      const repoA = infoA.repos[0].name as string;
      const repoB = infoB.repos[0].name as string;
      expect(repoA).not.toBe(repoB);

      const reviewsA = (await (
        await fetch(
          `${base}/open-reviews?workspace=${encodeURIComponent(workspaceA)}&repo=${encodeURIComponent(repoA)}`,
        )
      ).json()) as OpenReviewSummary[];
      expect(reviewsA).toHaveLength(1);
      expect(reviewsA[0]!.scope).toEqual(scopeA);
      expect(reviewsA[0]!.latestActivity).toBe("2026-07-18T11:00:00.000Z");

      const wrongRepo = await fetch(
        `${base}/open-reviews?workspace=${encodeURIComponent(workspaceA)}&repo=${encodeURIComponent(repoB)}`,
      );
      expect(wrongRepo.status).toBe(404);
      const missingWorkspace = await fetch(
        `${base}/open-reviews?workspace=${encodeURIComponent(join(scratch, "missing"))}&repo=${encodeURIComponent(repoA)}`,
      );
      expect(missingWorkspace.status).toBe(404);
      expect((await fetch(`${base}/open-reviews`)).status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
