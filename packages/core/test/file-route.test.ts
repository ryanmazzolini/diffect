import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
