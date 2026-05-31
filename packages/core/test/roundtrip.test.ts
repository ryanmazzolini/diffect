import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { createServer } from "../src/daemon.js";
import { loadThreads } from "../src/reviews/event-log.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "diffect-rt-"));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "t@e.com"]);
  await git(dir, ["config", "user.name", "T"]);
  await writeFile(join(dir, "a.txt"), "one\ntwo\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "base"]);
  await writeFile(join(dir, "a.txt"), "one\nTWO\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Mirrors the manual acceptance check: the browser POSTs a thread, and with the
 * daemon conceptually stopped, the CLI's file store sees it.
 */
describe("daemon → file store round trip", () => {
  it("POST /threads writes to .reviews/ that loadThreads (CLI path) then reads", async () => {
    const server = await createServer({
      workspacePath: dir,
      now: () => "2026-05-31T12:00:00.000Z",
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    // Discover the repo's URL-safe name (its basename) from the workspace.
    const ws = await (await fetch(`${base}/workspace`)).json();
    const repo: string = ws.repos[0].name;
    expect(repo).not.toBe(".");

    // The diff endpoint shows the work change.
    const diffRes = await fetch(`${base}/repos/${encodeURIComponent(repo)}/diff`);
    expect(diffRes.status).toBe(200);
    const diff = await diffRes.json();
    expect(diff.files.some((f: { path: string }) => f.path === "a.txt")).toBe(true);

    // Create a thread the way the browser would.
    const postRes = await fetch(`${base}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo,
        file: "a.txt",
        side: "new",
        line: 2,
        body: "should this be uppercase?",
      }),
    });
    expect(postRes.status).toBe(201);

    // GET /threads sees it.
    const open = await (await fetch(`${base}/threads?status=open`)).json();
    expect(open).toHaveLength(1);

    await new Promise<void>((r) => server.close(() => r()));

    // With the daemon closed, the CLI's loadThreads reads the same state.
    const threads = await loadThreads(dir);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.comments[0]!.body).toBe("should this be uppercase?");
    expect(threads[0]!.file).toBe("a.txt");
  });
});
