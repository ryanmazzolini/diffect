import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { createServer } from "../src/daemon.js";

let dir: string;
let base: string;
let close: () => Promise<void>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "diffect-files-"));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "t@e.com"]);
  await git(dir, ["config", "user.name", "T"]);
  await writeFile(join(dir, "a.txt"), "a\n");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "b.txt"), "b\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "base"]);

  const server = await createServer({ workspacePath: dir });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((r) => server.close(() => r()));
});
afterEach(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

it("GET /repos/:repo/files lists tracked files", async () => {
  const repo = (await (await fetch(`${base}/workspace`)).json()).repos[0].name;
  const res = await fetch(`${base}/repos/${repo}/files`);
  expect(res.status).toBe(200);
  const { files } = await res.json();
  expect(files.sort()).toEqual(["a.txt", "src/b.txt"]);
});

it("GET /repos/:repo/refs exposes Repo Start for a root comparison", async () => {
  const repo = (await (await fetch(`${base}/workspace`)).json()).repos[0].name;
  const refsResponse = await fetch(`${base}/repos/${repo}/refs`);

  expect(refsResponse.status).toBe(200);
  const refs = await refsResponse.json();
  expect(refs.repoStartSha).toMatch(/^[0-9a-f]{40}$/);

  const target = `${refs.repoStartSha}..main`;
  const diff = await fetch(
    `${base}/repos/${repo}/diff?target=${encodeURIComponent(target)}`,
  );
  expect(diff.status).toBe(200);
  expect((await diff.json()).files.map((file: { path: string }) => file.path).sort()).toEqual([
    "a.txt",
    "src/b.txt",
  ]);
});

it("404s for an unknown repo", async () => {
  expect((await fetch(`${base}/repos/nope/files`)).status).toBe(404);
});
