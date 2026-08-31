import { spawn, type ChildProcess } from "node:child_process";
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  ExistingWritableReviewError,
  ReviewService,
} from "../src/reviews/review-service.js";

const childMode = process.env.DIFFECT_REVIEW_PROCESS_CHILD === "1";

if (childMode) {
  it("runs one Review promotion in an isolated process", async () => {
    const repository = process.env.DIFFECT_REVIEW_PROCESS_REPO!;
    const output = process.env.DIFFECT_REVIEW_PROCESS_OUTPUT!;
    const ready = process.env.DIFFECT_REVIEW_PROCESS_READY;
    const release = process.env.DIFFECT_REVIEW_PROCESS_RELEASE;
    const firstByte = process.env.DIFFECT_REVIEW_PROCESS_ROLE === "first" ? "a" : "d";
    const values = [firstByte.repeat(32), nextHex(firstByte).repeat(32), nextHex(nextHex(firstByte)).repeat(32)];
    const service = new ReviewService({
      idBytes: () => values.shift()!,
      ...(ready && release
        ? {
            beforeAppend: async () => {
              await writeFile(ready, "ready", "utf8");
              await waitForFile(release);
            },
          }
        : {}),
    });

    const attempt = process.env.DIFFECT_REVIEW_PROCESS_ATTEMPT;
    if (attempt) await writeFile(attempt, "attempting", "utf8");

    let result: { status: "created"; id: string } | { status: "existing"; id: string };
    try {
      const review = await service.promoteFirstComment(
        { repositoryRoot: repository, worktreeRoot: repository },
        {
          operationId: process.env.DIFFECT_REVIEW_PROCESS_OPERATION!,
          location: {
            path: "src/example.ts",
            side: "new",
            startLine: 1,
            endLine: 1,
          },
          severity: null,
          author: { type: "user" },
          body: "Cross-process promotion.",
        },
      );
      result = { status: "created", id: review.id };
    } catch (error) {
      if (!(error instanceof ExistingWritableReviewError)) throw error;
      result = { status: "existing", id: error.review.id };
    }
    await writeFile(output, JSON.stringify(result), "utf8");
    expect(result.id).toMatch(/^rvw_[a-f0-9]{32}$/);
  });
} else {
  it("serializes different promotion operations across processes", async () => {
    const [first, second] = await processRace(false);
    expect(first.status).toBe("created");
    expect(second).toEqual({ status: "existing", id: first.id });
  });

  it("deduplicates one promotion operation across processes", async () => {
    const [first, second] = await processRace(true);
    expect(first.status).toBe("created");
    expect(second).toEqual({ status: "created", id: first.id });
  });
}

interface ProcessResult {
  status: "created" | "existing";
  id: string;
}

async function processRace(sameOperation: boolean): Promise<[ProcessResult, ProcessResult]> {
  const root = await mkdtemp(join(tmpdir(), "diffect-review-process-"));
  const repositoryPath = join(root, "repo");
  const xdg = join(root, "xdg");
  await Promise.all([mkdir(repositoryPath), mkdir(xdg)]);
  const repository = await realpath(repositoryPath);
  const ready = join(root, "ready");
  const release = join(root, "release");
  const firstOutput = join(root, "first.json");
  const secondOutput = join(root, "second.json");
  const secondAttempt = join(root, "second-attempt");
  const firstOperation = `op_${"1".repeat(32)}`;
  const secondOperation = sameOperation ? firstOperation : `op_${"2".repeat(32)}`;

  try {
    const first = spawnChild({
      repository,
      xdg,
      output: firstOutput,
      operation: firstOperation,
      role: "first",
      ready,
      release,
    });
    await waitForFile(ready);
    const second = spawnChild({
      repository,
      xdg,
      output: secondOutput,
      operation: secondOperation,
      role: "second",
      attempt: secondAttempt,
    });
    await waitForFile(secondAttempt);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(access(secondOutput)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(release, "release", "utf8");
    await Promise.all([waitForChild(first), waitForChild(second)]);

    return [
      JSON.parse(await readFile(firstOutput, "utf8")) as ProcessResult,
      JSON.parse(await readFile(secondOutput, "utf8")) as ProcessResult,
    ];
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

interface ChildOptions {
  repository: string;
  xdg: string;
  output: string;
  operation: string;
  role: "first" | "second";
  ready?: string;
  release?: string;
  attempt?: string;
}

function spawnChild(options: ChildOptions): ChildProcess {
  const coreRoot = dirname(fileURLToPath(import.meta.url)).replace(/\/test$/, "");
  return spawn(
    "pnpm",
    ["exec", "vitest", "run", "test/review-service-process.test.ts", "--reporter=dot"],
    {
      cwd: coreRoot,
      env: {
        ...process.env,
        DIFFECT_TEST_XDG_CONFIG_HOME: options.xdg,
        DIFFECT_REVIEW_PROCESS_CHILD: "1",
        DIFFECT_REVIEW_PROCESS_REPO: options.repository,
        DIFFECT_REVIEW_PROCESS_OUTPUT: options.output,
        DIFFECT_REVIEW_PROCESS_OPERATION: options.operation,
        DIFFECT_REVIEW_PROCESS_ROLE: options.role,
        ...(options.ready ? { DIFFECT_REVIEW_PROCESS_READY: options.ready } : {}),
        ...(options.release ? { DIFFECT_REVIEW_PROCESS_RELEASE: options.release } : {}),
        ...(options.attempt ? { DIFFECT_REVIEW_PROCESS_ATTEMPT: options.attempt } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function waitForChild(child: ChildProcess): Promise<void> {
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`Review child process failed (${code}):\n${output}`);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

function nextHex(value: string): string {
  return (Number.parseInt(value, 16) + 1).toString(16);
}
