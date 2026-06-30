import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/daemon.js";
import { git } from "../src/git/exec.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "diffect-pr-draft-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("PR Draft", () => {
  it("stores a repo-scoped PR Draft packet", async () => {
    await initRepo(dir, "a.txt", "one\n");
    const server = await createServer({
      workspacePath: dir,
      now: () => "2026-06-25T12:00:00.000Z",
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const path = `/pr-draft?workspace=${encodeURIComponent(dir)}`;

    const repoName = basename(dir);
    const empty = await (await fetch(`${base}${path}`)).json();
    expect(empty).toMatchObject({ repo: repoName, title: "", body: "", updatedAt: null });

    const saved = await fetch(`${base}${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Test PR", body: "## Summary\nDone" }),
    });
    expect(saved.status).toBe(200);

    const next = await (await fetch(`${base}${path}`)).json();
    expect(next).toMatchObject({
      workspacePath: dir,
      repo: repoName,
      worktree: null,
      branch: "main",
      title: "Test PR",
      body: "## Summary\nDone",
      updatedAt: "2026-06-25T12:00:00.000Z",
    });

    await new Promise<void>((r) => server.close(() => r()));
  });

  it("keeps multi-repo PR Draft packets separate", async () => {
    const alpha = join(dir, "alpha");
    const beta = join(dir, "beta");
    await initRepo(alpha, "alpha.txt", "alpha\n");
    await initRepo(beta, "beta.txt", "beta\n");
    const server = await createServer({
      workspacePath: dir,
      now: () => "2026-06-25T12:00:00.000Z",
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const path = (repo: string) => `/pr-draft?workspace=${encodeURIComponent(dir)}&repo=${repo}`;

    await fetch(`${base}${path("alpha")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Alpha PR", body: "alpha body" }),
    });
    await fetch(`${base}${path("beta")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Beta PR", body: "beta body" }),
    });

    await expect((await fetch(`${base}${path("alpha")}`)).json()).resolves.toMatchObject({
      repo: "alpha",
      title: "Alpha PR",
      body: "alpha body",
    });
    await expect((await fetch(`${base}${path("beta")}`)).json()).resolves.toMatchObject({
      repo: "beta",
      title: "Beta PR",
      body: "beta body",
    });

    await new Promise<void>((r) => server.close(() => r()));
  });
});

async function initRepo(path: string, file: string, contents: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, ["init", "-b", "main"]);
  await git(path, ["config", "user.email", "t@e.com"]);
  await git(path, ["config", "user.name", "T"]);
  await writeFile(join(path, file), contents);
  await git(path, ["add", "."]);
  await git(path, ["commit", "-m", "base"]);
}
