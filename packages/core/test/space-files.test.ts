import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { createServer } from "../src/daemon.js";

let dir: string;
let repo: string;
let base: string;
let close: () => Promise<void>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "diffect-space-files-"));
  repo = join(dir, "app");
  await mkdir(join(dir, ".plans"), { recursive: true });
  await writeFile(join(dir, "notes.md"), "one\ntwo\n");
  await writeFile(join(dir, ".plans", "plan.md"), "plan\n");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "t@e.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await writeFile(join(repo, "app.txt"), "repo\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);

  const server = await createServer({ workspacePath: dir, now: () => "2026-01-01T00:00:00.000Z" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((r) => server.close(() => r()));
});

afterEach(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

it("lists broad non-repo space files", async () => {
  const res = await fetch(`${base}/space/files?workspace=${encodeURIComponent(dir)}`);
  expect(res.status).toBe(200);
  const { files } = await res.json();
  expect(files).toEqual([".plans/plan.md", "notes.md"]);
});

it("reads and comments on a space file", async () => {
  const read = await fetch(
    `${base}/space/file?workspace=${encodeURIComponent(dir)}&path=notes.md&from=1&to=2`,
  );
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual({ from: 1, lines: ["one", "two"] });

  const created = await fetch(`${base}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repo: null,
      spacePath: dir,
      targetLevel: "file",
      file: "notes.md",
      side: "new",
      line: 2,
      body: "space file note",
    }),
  });
  expect(created.status).toBe(201);
  const thread = await created.json();
  expect(thread).toMatchObject({ repo: null, spacePath: dir, targetLevel: "file", file: "notes.md", line: 2 });

  const threads = await (await fetch(`${base}/threads?space=${encodeURIComponent(dir)}`)).json();
  expect(threads).toHaveLength(1);
  expect(threads[0]).toMatchObject({ repo: null, spacePath: dir, file: "notes.md" });
});
