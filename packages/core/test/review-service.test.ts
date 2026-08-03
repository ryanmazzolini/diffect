import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExistingWritableReviewError,
  ReviewService,
  UnknownReviewError,
  UnknownReviewThreadError,
} from "../src/reviews/service.js";
import { readRepositoryReviewEvents } from "../src/reviews/store.js";
import { repoStoreDir, reviewEventsPath } from "../src/store/paths.js";

let root: string;
let repo: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "diffect-review-service-"));
  const repoPath = join(root, "repo");
  await mkdir(repoPath);
  repo = await realpath(repoPath);
});

afterEach(async () => {
  await rm(repoStoreDir(repo), { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

function ids() {
  const values = ["1".repeat(32), "2".repeat(32), "3".repeat(32)];
  return () => values.shift()!;
}

function firstComment() {
  return {
    location: {
      path: "src/example.ts",
      side: "new" as const,
      startLine: 3,
      endLine: 5,
    },
    severity: "suggestion" as const,
    author: { type: "user" as const },
    body: "Keep this boundary explicit.",
  };
}

it("promotes the first comment as one replayable record", async () => {
  const service = new ReviewService({
    now: () => "2026-07-31T12:00:00.000Z",
    idBytes: ids(),
  });

  const review = await service.promoteFirstComment(
    { repositoryRoot: repo, worktreeRoot: repo },
    firstComment(),
  );

  expect(review.id).toBe(`rvw_${"1".repeat(32)}`);
  expect(review.threads[0]!.id).toBe(`rth_${"2".repeat(32)}`);
  expect(review.threads[0]!.comments[0]!.id).toBe(`rcm_${"3".repeat(32)}`);
  const raw = await readFile(reviewEventsPath(repo), "utf8");
  expect(raw.trim().split("\n")).toHaveLength(1);
  expect(await readRepositoryReviewEvents(repo)).toHaveLength(1);
});

it("recovers exact Review and Thread reads through a fresh service", async () => {
  const created = await new ReviewService({ idBytes: ids() }).promoteFirstComment(
    { repositoryRoot: repo, worktreeRoot: repo },
    firstComment(),
  );

  const restarted = new ReviewService();
  await expect(restarted.getReview(created.id)).resolves.toEqual(created);
  await expect(restarted.getThread(created.threads[0]!.id)).resolves.toMatchObject({
    review: { id: created.id },
    thread: { id: created.threads[0]!.id },
  });
  expect(restarted.linkFor(created.id)).toBe(
    `http://127.0.0.1:7421/reviews/${created.id}`,
  );
});

it("does not append when validation or pre-append work fails", async () => {
  const invalid = new ReviewService({ idBytes: ids() });
  await expect(
    invalid.promoteFirstComment(
      { repositoryRoot: repo, worktreeRoot: repo },
      { ...firstComment(), body: "  " },
    ),
  ).rejects.toThrow(/must not be blank/);

  const failed = new ReviewService({
    idBytes: ids(),
    beforeAppend: () => {
      throw new Error("prepared diff vanished");
    },
  });
  await expect(
    failed.promoteFirstComment(
      { repositoryRoot: repo, worktreeRoot: repo },
      firstComment(),
    ),
  ).rejects.toThrow("prepared diff vanished");
  await expect(readRepositoryReviewEvents(repo)).resolves.toEqual([]);
});

it("serializes simultaneous promotion attempts within one daemon", async () => {
  let releaseAppend!: () => void;
  const appendGate = new Promise<void>((resolve) => {
    releaseAppend = resolve;
  });
  let enteredAppend!: () => void;
  const appendEntered = new Promise<void>((resolve) => {
    enteredAppend = resolve;
  });
  const service = new ReviewService({
    idBytes: ids(),
    beforeAppend: async () => {
      enteredAppend();
      await appendGate;
    },
  });
  const context = { repositoryRoot: repo, worktreeRoot: repo };
  const first = service.promoteFirstComment(context, firstComment());
  await appendEntered;
  const second = service.promoteFirstComment(context, firstComment());
  releaseAppend();

  const results = await Promise.allSettled([first, second]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((result) => result.status === "rejected");
  expect(rejected).toMatchObject({ reason: expect.any(ExistingWritableReviewError) });
  expect(await readRepositoryReviewEvents(repo)).toHaveLength(1);
});

it("returns the existing writable Review for the same working context", async () => {
  const service = new ReviewService({ idBytes: ids() });
  const review = await service.promoteFirstComment(
    { repositoryRoot: repo, worktreeRoot: repo },
    firstComment(),
  );

  await expect(
    service.promoteFirstComment(
      { repositoryRoot: repo, worktreeRoot: repo },
      firstComment(),
    ),
  ).rejects.toMatchObject<Partial<ExistingWritableReviewError>>({
    review: { id: review.id },
  });
});

it("rejects unknown opaque IDs exactly", async () => {
  const service = new ReviewService();
  await expect(service.getReview(`rvw_${"a".repeat(32)}`)).rejects.toBeInstanceOf(
    UnknownReviewError,
  );
  await expect(
    service.getThread(`rth_${"b".repeat(32)}`),
  ).rejects.toBeInstanceOf(UnknownReviewThreadError);
  await expect(service.getReview("sess_old-alias")).rejects.toBeInstanceOf(
    UnknownReviewError,
  );
});

it("never reads or modifies legacy feedback files", async () => {
  const inTree = join(repo, ".reviews", "threads.jsonl");
  const central = join(repoStoreDir(repo), "threads.jsonl");
  await mkdir(join(repo, ".reviews"), { recursive: true });
  await mkdir(repoStoreDir(repo), { recursive: true });
  await writeFile(inTree, '{"legacy":"in-tree"}\n');
  await writeFile(central, '{"legacy":"central"}\n');
  const before = await Promise.all([digest(inTree), digest(central)]);

  const review = await new ReviewService({ idBytes: ids() }).promoteFirstComment(
    { repositoryRoot: repo, worktreeRoot: repo },
    firstComment(),
  );
  await new ReviewService().getReview(review.id);

  expect(await Promise.all([digest(inTree), digest(central)])).toEqual(before);
});

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
