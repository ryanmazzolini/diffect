import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  ExistingWritableReviewError,
  InvalidFirstReviewCommentError,
  ReviewOperationConflictError,
  ReviewService,
  ReviewStoreCorruptError,
} from "../src/reviews/review-service.js";
import {
  repoStoreDir,
  reviewEventsPath,
  reviewStoreDir,
  threadsLogPath,
} from "../src/store/paths.js";

let root: string;
const repositories: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "diffect-clean-review-"));
});

afterEach(async () => {
  await Promise.all(
    repositories.splice(0).map((repository) =>
      rm(repoStoreDir(repository), { recursive: true, force: true }),
    ),
  );
  await rm(root, { recursive: true, force: true });
});

async function directory(name: string): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  return realpath(path);
}

async function repository(name: string): Promise<string> {
  const path = await directory(name);
  repositories.push(path);
  return path;
}

function ids(...values: string[]): () => string {
  const pending = [...values];
  return () => {
    const value = pending.shift();
    if (!value) throw new Error("unexpected ID allocation");
    return value;
  };
}

function firstComment(operation = "1".repeat(32)) {
  return {
    operationId: `op_${operation}`,
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

function service() {
  return new ReviewService({
    now: () => "2026-08-18T14:00:00.000Z",
    idBytes: ids("a".repeat(32), "b".repeat(32), "c".repeat(32)),
  });
}

it("promotes the first comment as one replayable Review event", async () => {
  const repo = await repository("repo");
  const review = await service().promoteFirstComment(
    { repositoryRoot: repo, worktreeRoot: repo },
    firstComment(),
  );

  expect(review).toMatchObject({
    id: `rvw_${"a".repeat(32)}`,
    repository: { root: repo },
    worktree: { root: repo },
    threads: [
      {
        id: `rth_${"b".repeat(32)}`,
        comments: [{ id: `rcm_${"c".repeat(32)}` }],
      },
    ],
  });
  const raw = await readFile(reviewEventsPath(repo, review.id), "utf8");
  expect(raw.endsWith("\n")).toBe(true);
  expect(raw.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(raw)).toMatchObject({
    type: "review.created",
    operationId: firstComment().operationId,
    review: { id: review.id },
  });
});

it("recovers an exact Review through a fresh service and canonical link", async () => {
  const repo = await repository("repo");
  const created = await service().promoteFirstComment(
    { repositoryRoot: repo, worktreeRoot: repo },
    firstComment(),
  );

  const restarted = new ReviewService();
  await expect(restarted.getReview(created.id)).resolves.toEqual(created);
  expect(restarted.linkFor(created.id)).toBe(
    `http://127.0.0.1:13433/reviews/${created.id}`,
  );
});

it("keeps a Current changes lookup side-effect free", async () => {
  const repo = await repository("repo");
  await expect(
    new ReviewService().findWritable({ repositoryRoot: repo, worktreeRoot: repo }),
  ).resolves.toBeNull();
  await expect(access(reviewStoreDir(repo))).rejects.toMatchObject({ code: "ENOENT" });
});

it("returns the original result when an operation is retried", async () => {
  const repo = await repository("repo");
  const reviewService = service();
  const context = { repositoryRoot: repo, worktreeRoot: repo };
  const created = await reviewService.promoteFirstComment(context, firstComment());
  const retried = await reviewService.promoteFirstComment(context, firstComment());

  expect(retried).toEqual(created);
  expect((await readFile(reviewEventsPath(repo, created.id), "utf8")).trim().split("\n"))
    .toHaveLength(1);
});

it("rejects reusing an operation ID for different input", async () => {
  const repo = await repository("repo");
  const reviewService = service();
  const context = { repositoryRoot: repo, worktreeRoot: repo };
  await reviewService.promoteFirstComment(context, firstComment());

  await expect(
    reviewService.promoteFirstComment(context, {
      ...firstComment(),
      body: "Different request.",
    }),
  ).rejects.toBeInstanceOf(ReviewOperationConflictError);
});

it("serializes simultaneous promotions across service instances", async () => {
  const repo = await repository("repo");
  let releaseAppend!: () => void;
  const appendGate = new Promise<void>((resolve) => {
    releaseAppend = resolve;
  });
  let enteredAppend!: () => void;
  const appendEntered = new Promise<void>((resolve) => {
    enteredAppend = resolve;
  });
  const first = new ReviewService({
    idBytes: ids("a".repeat(32), "b".repeat(32), "c".repeat(32)),
    beforeAppend: async () => {
      enteredAppend();
      await appendGate;
    },
  });
  const second = new ReviewService({
    idBytes: ids("d".repeat(32), "e".repeat(32), "f".repeat(32)),
  });
  const context = { repositoryRoot: repo, worktreeRoot: repo };
  const firstPromotion = first.promoteFirstComment(context, firstComment("1".repeat(32)));
  await appendEntered;
  const secondPromotion = second.promoteFirstComment(
    context,
    firstComment("2".repeat(32)),
  );
  releaseAppend();

  const results = await Promise.allSettled([firstPromotion, secondPromotion]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({
    reason: expect.any(ExistingWritableReviewError),
  });
});

it("deduplicates simultaneous retries across service instances", async () => {
  const repo = await repository("repo");
  const context = { repositoryRoot: repo, worktreeRoot: repo };
  const one = service();
  const two = new ReviewService({
    idBytes: ids("d".repeat(32), "e".repeat(32), "f".repeat(32)),
  });

  const [first, second] = await Promise.all([
    one.promoteFirstComment(context, firstComment()),
    two.promoteFirstComment(context, firstComment()),
  ]);
  expect(second).toEqual(first);
  expect((await readFile(reviewEventsPath(repo, first.id), "utf8")).trim().split("\n"))
    .toHaveLength(1);
});

it("recovers a valid event whose final newline was not flushed", async () => {
  const repo = await repository("repo");
  const reviewService = service();
  const context = { repositoryRoot: repo, worktreeRoot: repo };
  const created = await reviewService.promoteFirstComment(context, firstComment());
  const path = reviewEventsPath(repo, created.id);
  await writeFile(path, (await readFile(path, "utf8")).trimEnd(), "utf8");

  await expect(reviewService.promoteFirstComment(context, firstComment())).resolves.toEqual(
    created,
  );
  expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
});

it("drops only an invalid crash fragment before the next mutation", async () => {
  const repo = await repository("repo");
  const partialId = `rvw_${"9".repeat(32)}`;
  await mkdir(reviewStoreDir(repo), { recursive: true });
  await writeFile(reviewEventsPath(repo, partialId), '{"version":1,"type":"review.', "utf8");

  const created = await service().promoteFirstComment(
    { repositoryRoot: repo, worktreeRoot: repo },
    firstComment(),
  );
  expect(created.id).toBe(`rvw_${"a".repeat(32)}`);
  await expect(access(reviewEventsPath(repo, partialId))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("isolates exact reads from corruption in another Review store", async () => {
  const healthyRepo = await repository("healthy");
  const corruptRepo = await repository("corrupt");
  const healthy = await service().promoteFirstComment(
    { repositoryRoot: healthyRepo, worktreeRoot: healthyRepo },
    firstComment("1".repeat(32)),
  );
  const corrupt = await new ReviewService({
    idBytes: ids("d".repeat(32), "e".repeat(32), "f".repeat(32)),
  }).promoteFirstComment(
    { repositoryRoot: corruptRepo, worktreeRoot: corruptRepo },
    firstComment("2".repeat(32)),
  );
  await writeFile(
    reviewEventsPath(corruptRepo, corrupt.id),
    `${await readFile(reviewEventsPath(corruptRepo, corrupt.id), "utf8")}not-json\n`,
    "utf8",
  );

  await expect(new ReviewService().getReview(healthy.id)).resolves.toEqual(healthy);
  await expect(new ReviewService().getReview(corrupt.id)).rejects.toBeInstanceOf(
    ReviewStoreCorruptError,
  );
});

it("stores linked-worktree Reviews under the primary repository", async () => {
  const primary = await repository("primary");
  const linked = await directory("linked");
  const created = await service().promoteFirstComment(
    { repositoryRoot: primary, worktreeRoot: linked },
    firstComment(),
  );

  expect(created.repository.root).toBe(primary);
  expect(created.worktree.root).toBe(linked);
  await expect(access(reviewEventsPath(primary, created.id))).resolves.toBeUndefined();
  await expect(access(reviewEventsPath(linked, created.id))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("never reads or modifies session-era feedback files", async () => {
  const repo = await repository("repo");
  const inTree = join(repo, ".reviews", "threads.jsonl");
  const central = threadsLogPath(repo);
  await mkdir(join(repo, ".reviews"), { recursive: true });
  await mkdir(repoStoreDir(repo), { recursive: true });
  await writeFile(inTree, '{"session":"in-tree"}\n', "utf8");
  await writeFile(central, '{"session":"central"}\n', "utf8");
  const before = await Promise.all([digest(inTree), digest(central)]);

  const created = await service().promoteFirstComment(
    { repositoryRoot: repo, worktreeRoot: repo },
    firstComment(),
  );
  await new ReviewService().getReview(created.id);

  expect(await Promise.all([digest(inTree), digest(central)])).toEqual(before);
});

it("validates the operation and comment before creating storage", async () => {
  const repo = await repository("repo");
  await expect(
    service().promoteFirstComment(
      { repositoryRoot: repo, worktreeRoot: repo },
      { ...firstComment(), operationId: "retry-me", body: "  " },
    ),
  ).rejects.toBeInstanceOf(InvalidFirstReviewCommentError);
  await expect(access(reviewStoreDir(repo))).rejects.toMatchObject({ code: "ENOENT" });
});

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
