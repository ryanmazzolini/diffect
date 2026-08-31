import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LockOptions } from "proper-lockfile";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const lockMock = vi.hoisted(() => vi.fn());
vi.mock("proper-lockfile", () => ({ lock: lockMock }));

import {
  ReviewService,
  ReviewStoreBusyError,
} from "../src/reviews/review-service.js";
import { repoStoreDir } from "../src/store/paths.js";

let root: string;
let repo: string;

beforeEach(async () => {
  lockMock.mockReset();
  root = await mkdtemp(join(tmpdir(), "diffect-review-lock-"));
  const path = join(root, "repo");
  await mkdir(path);
  repo = await realpath(path);
});

afterEach(async () => {
  await rm(repoStoreDir(repo), { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

it("fails closed before writing when the repository lock is compromised", async () => {
  lockMock.mockImplementation(async (_path: string, options: LockOptions) => {
    options.onCompromised?.(new Error("lock ownership lost"));
    return async () => {};
  });
  const values = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];
  const service = new ReviewService({ idBytes: () => values.shift()! });

  await expect(
    service.promoteFirstComment(
      { repositoryRoot: repo, worktreeRoot: repo },
      {
        operationId: `op_${"1".repeat(32)}`,
        location: {
          path: "src/example.ts",
          side: "new",
          startLine: 1,
          endLine: 1,
        },
        severity: null,
        author: { type: "user" },
        body: "Do not race this write.",
      },
    ),
  ).rejects.toBeInstanceOf(ReviewStoreBusyError);

  expect(values).toHaveLength(3);
});
