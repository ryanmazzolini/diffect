import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { createServer } from "../src/daemon.js";

let ws: string;

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "t@e.com"]);
  await git(dir, ["config", "user.name", "T"]);
  await writeFile(join(dir, "f.txt"), "one\ntwo\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "base"]);
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "diffect-wt-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

/**
 * Regression guard: the central store is keyed by a repo's PRIMARY root, so a
 * thread filed against a *linked worktree* (whose root differs) must still land
 * in the repo's one store — visible to /threads and routable for mutations.
 * Keying writes by the worktree root instead silently orphans the thread.
 */
describe("linked-worktree thread routing", () => {
  it("creates, lists, and resolves a thread filed on a linked worktree", async () => {
    const primary = join(ws, "proj");
    await initRepo(primary);
    await git(primary, ["branch", "feature"]);
    await git(primary, ["worktree", "add", join(ws, "proj-feature"), "feature"]);

    const server = await createServer({ workspacePath: ws });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      const info = await (await fetch(`${base}/workspace`)).json();
      const repo: string = info.repos[0].name;

      const postRes = await fetch(`${base}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo,
          worktree: "proj-feature",
          file: "f.txt",
          side: "new",
          line: 1,
          body: "filed on the linked worktree",
        }),
      });
      expect(postRes.status).toBe(201);
      const created = await postRes.json();
      expect(created.worktree).toBe("proj-feature");

      // Aggregated list (keyed by primary root) must include it.
      const threads = await (await fetch(`${base}/threads`)).json();
      expect(threads).toHaveLength(1);
      expect(threads[0].worktree).toBe("proj-feature");

      // Mutation by id must route to the right store (not 404).
      const resolveRes = await fetch(
        `${base}/threads/${encodeURIComponent(created.id)}/resolve`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      expect(resolveRes.status).toBe(200);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
