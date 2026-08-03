import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { CurrentChangesResponse, ReviewResponse } from "@diffect/shared";
import { createServer } from "../src/daemon.js";
import { git } from "../src/git/exec.js";
import { repoStoreDir, reviewEventsPath } from "../src/store/paths.js";

let root: string;
let repo: string;
let webRoot: string;
let server: Server | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "diffect-review-daemon-"));
  const repoPath = join(root, "repo");
  webRoot = join(root, "web");
  await git(root, ["init", "-b", "main", "repo"]);
  repo = await realpath(repoPath);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await writeFile(join(repo, "example.ts"), "export const value = 1;\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
  await writeFile(join(repo, "example.ts"), "export const value = 2;\n");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<main>Review app</main>");
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  await rm(repoStoreDir(await realpath(repo)), { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

it("keeps one repository identity when opened from a linked worktree", async () => {
  const linked = join(root, "linked");
  await git(repo, ["branch", "feature"]);
  await git(repo, ["worktree", "add", linked, "feature"]);
  await writeFile(join(linked, "example.ts"), "export const value = 3;\n");

  server = await createServer({ workspacePath: linked, webRoot });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  let port = (server.address() as AddressInfo).port;
  let baseUrl = `http://127.0.0.1:${port}`;
  const workspace = await fetch(`${baseUrl}/api/workspace`).then((response) =>
    response.json(),
  ) as {
    repos: Array<{
      name: string;
      root: string;
      worktrees: Array<{ name: string; root: string }>;
    }>;
  };
  const repository = workspace.repos[0]!;
  expect(repository.root).toBe(await realpath(repo));
  expect(repository.worktrees.map((worktree) => worktree.root)).toEqual(
    expect.arrayContaining([await realpath(repo), linked]),
  );

  const query = `repo=${encodeURIComponent(repository.name)}&worktree=linked`;
  const current = await fetch(`${baseUrl}/api/current-changes?${query}`).then(
    (response) => response.json(),
  ) as CurrentChangesResponse;
  expect(current.worktree.root).toBe(linked);
  const createdResponse = await fetch(`${baseUrl}/api/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repo: repository.name,
      worktree: "linked",
      location: { path: "example.ts", side: "new", startLine: 1, endLine: 1 },
      severity: null,
      author: { type: "user" },
      body: "Linked checkout feedback.",
    }),
  });
  expect(createdResponse.status).toBe(201);
  const created = (await createdResponse.json()) as ReviewResponse;
  expect(created.review.repository.root).toBe(await realpath(repo));
  expect(created.review.worktree.root).toBe(await realpath(linked));

  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = await createServer({ workspacePath: root, webRoot });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
  expect(
    (await fetch(`${baseUrl}/api/reviews/${created.review.id}/diff`)).status,
  ).toBe(200);
});

it("traces one Review through API, canonical route, exact reads, and restart", async () => {
  const inTreeLegacy = join(repo, ".reviews", "threads.jsonl");
  const centralLegacy = join(repoStoreDir(repo), "threads.jsonl");
  await mkdir(join(repo, ".reviews"), { recursive: true });
  await mkdir(repoStoreDir(repo), { recursive: true });
  await writeFile(inTreeLegacy, "legacy in-tree bytes\n");
  await writeFile(centralLegacy, "legacy central bytes\n");
  const legacyBefore = await Promise.all([
    digest(inTreeLegacy),
    digest(centralLegacy),
  ]);

  let baseUrl = await start();
  for (const removedPath of [
    "/workspace",
    "/threads",
    "/open-reviews",
    "/events",
    "/repos/example/diff",
    "/attachments",
  ]) {
    expect((await fetch(`${baseUrl}${removedPath}`)).status).toBe(404);
  }
  expect(
    (
      await fetch(`${baseUrl}/attachments`, {
        method: "POST",
        body: "legacy attachment",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await fetch(`${baseUrl}/api/health`, {
        headers: { origin: "https://attacker.example" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${baseUrl}/api/reviews`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      })
    ).status,
  ).toBe(400);

  const currentResponse = await fetch(`${baseUrl}/api/current-changes`);
  expect(currentResponse.status).toBe(200);
  const current = (await currentResponse.json()) as CurrentChangesResponse;
  expect(current.review).toBeNull();
  expect(current.diff.files).toHaveLength(1);
  expect(current.diff.files[0]).toMatchObject({
    path: "example.ts",
    old: "export const value = 1;\n",
    new: "export const value = 2;\n",
  });

  const failed = await fetch(`${baseUrl}/api/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repo: current.repository.name,
      worktree: null,
      location: { path: "missing.ts", side: "new", startLine: 1, endLine: 1 },
      severity: null,
      author: { type: "user" },
      body: "This must fail before append.",
    }),
  });
  expect(failed.status).toBe(400);
  await expect(readFile(reviewEventsPath(repo), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });

  const createdResponse = await fetch(`${baseUrl}/api/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repo: current.repository.name,
      worktree: null,
      location: { path: "example.ts", side: "new", startLine: 1, endLine: 1 },
      severity: "suggestion",
      author: { type: "user" },
      body: "Keep this value named for its purpose.",
    }),
  });
  expect(createdResponse.status).toBe(201);
  const created = (await createdResponse.json()) as ReviewResponse;
  expect(created.link).toBe(
    `http://127.0.0.1:7421/reviews/${created.review.id}`,
  );

  const browserRoute = await fetch(`${baseUrl}/reviews/${created.review.id}`);
  expect(browserRoute.status).toBe(200);
  expect(await browserRoute.text()).toContain("Review app");

  const exact = await fetch(`${baseUrl}/api/reviews/${created.review.id}`);
  expect(exact.status).toBe(200);
  expect((await exact.json()) as ReviewResponse).toEqual(created);

  const threadId = created.review.threads[0]!.id;
  const exactThread = await fetch(`${baseUrl}/api/review-threads/${threadId}`);
  expect(exactThread.status).toBe(200);
  expect(await exactThread.json()).toMatchObject({
    review: { id: created.review.id },
    thread: { id: threadId },
    reviewLink: created.link,
  });

  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  baseUrl = await start();
  const restarted = await fetch(`${baseUrl}/api/reviews/${created.review.id}`);
  expect(restarted.status).toBe(200);
  expect((await restarted.json()) as ReviewResponse).toEqual(created);

  expect(
    await fetch(`${baseUrl}/api/reviews/rvw_${"f".repeat(32)}`).then((response) =>
      response.status,
    ),
  ).toBe(404);

  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = await createServer({ webRoot });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  expect((await fetch(`${baseUrl}/api/reviews/${created.review.id}`)).status).toBe(200);
  expect(
    (await fetch(`${baseUrl}/api/reviews/${created.review.id}/diff`)).status,
  ).toBe(409);

  expect(await Promise.all([digest(inTreeLegacy), digest(centralLegacy)])).toEqual(
    legacyBefore,
  );
});

async function start(): Promise<string> {
  server = await createServer({ workspacePath: repo, webRoot });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
