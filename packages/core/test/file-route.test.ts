import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { createServer } from "../src/daemon.js";

let dir: string;
let base: string;
let close: () => Promise<void>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "diffect-file-"));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "t@e.com"]);
  await git(dir, ["config", "user.name", "T"]);
  await writeFile(join(dir, "f.txt"), "L1\nL2\nL3\nL4\nL5\n");
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

describe("GET /repos/:repo/file", () => {
  it("returns the requested new-side line range", async () => {
    const repo = (await (await fetch(`${base}/workspace`)).json()).repos[0].name;
    const res = await fetch(
      `${base}/repos/${repo}/file?path=f.txt&side=new&from=2&to=4`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ from: 2, lines: ["L2", "L3", "L4"] });
  });

  it("refuses to read outside the repo (path traversal)", async () => {
    const repo = (await (await fetch(`${base}/workspace`)).json()).repos[0].name;
    const res = await fetch(
      `${base}/repos/${repo}/file?path=${encodeURIComponent(
        "../../../../../../etc/passwd",
      )}&side=new&from=1&to=1`,
    );
    expect(res.status).toBe(404); // contained-path guard → not found, never leaked
  });

  it("400s on missing/invalid range params", async () => {
    const repo = (await (await fetch(`${base}/workspace`)).json()).repos[0].name;
    expect(
      (await fetch(`${base}/repos/${repo}/file?path=f.txt&side=new`)).status,
    ).toBe(400);
    expect(
      (await fetch(`${base}/repos/${repo}/file?path=f.txt&from=4&to=2`)).status,
    ).toBe(400);
  });
});

describe("GET /repos/:repo/file/content", () => {
  it("returns full old and new content for a work-target change", async () => {
    const repo = (await (await fetch(`${base}/workspace`)).json()).repos[0].name;
    // base committed f.txt = L1..L5; make an unstaged edit so old !== new.
    await writeFile(join(dir, "f.txt"), "L1\nL2x\nL3\nL4\nL5\n");
    const res = await fetch(`${base}/repos/${repo}/file/content?path=f.txt&target=work`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      old: "L1\nL2\nL3\nL4\nL5\n",
      new: "L1\nL2x\nL3\nL4\nL5\n",
    });
  });

  it("returns an empty (not null) old side for an added file", async () => {
    const repo = (await (await fetch(`${base}/workspace`)).json()).repos[0].name;
    await writeFile(join(dir, "added.txt"), "fresh\n");
    await git(dir, ["add", "added.txt"]);
    const res = await fetch(`${base}/repos/${repo}/file/content?path=added.txt&target=work`);
    expect(await res.json()).toEqual({ old: "", new: "fresh\n" });
  });

  it("400s when path is missing", async () => {
    const repo = (await (await fetch(`${base}/workspace`)).json()).repos[0].name;
    expect((await fetch(`${base}/repos/${repo}/file/content?target=work`)).status).toBe(400);
  });

  it("returns a symlink's target path string (the git blob), not the target's content", async () => {
    const repo = (await (await fetch(`${base}/workspace`)).json()).repos[0].name;
    await writeFile(join(dir, "target.txt"), "TARGET CONTENT\n");
    await symlink("target.txt", join(dir, "link.txt"));
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "add symlink"]);
    const res = await fetch(`${base}/repos/${repo}/file/content?path=link.txt&target=work`);
    // git stores the link's target string as its blob; both sides must match it
    // (the worktree side must readlink, not follow into target.txt's bytes).
    expect(await res.json()).toEqual({ old: "target.txt", new: "target.txt" });
  });
});
