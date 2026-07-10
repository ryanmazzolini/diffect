import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { createServer } from "../src/daemon.js";

let xdg: string;
let scratch: string;

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "t@e.com"]);
  await git(dir, ["config", "user.name", "T"]);
  await writeFile(join(dir, "f.txt"), "one\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "base"]);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  // Per-test registry isolation (the registry is one fixed file under XDG).
  xdg = await mkdtemp(join(tmpdir(), "diffect-mws-xdg-"));
  process.env.XDG_CONFIG_HOME = xdg;
  scratch = await mkdtemp(join(tmpdir(), "diffect-mws-"));
});
afterEach(async () => {
  await rm(xdg, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

describe("multi-workspace daemon", () => {
  it("aggregates repos across workspaces and lists them per path", async () => {
    const repoA = join(scratch, "alpha");
    const repoB = join(scratch, "beta");
    await initRepo(repoA);
    await initRepo(repoB);

    const server = await createServer({ workspacePath: repoA });
    const base = await listen(server);
    try {
      // Boot serves only the seed workspace.
      let info = await (await fetch(`${base}/workspace`)).json();
      expect(info.repos.map((r: { name: string }) => r.name)).toEqual(["alpha"]);

      // Add the second workspace (loopback default allows it).
      const addRes = await fetch(`${base}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: repoB }),
      });
      expect(addRes.status).toBe(200);

      // The aggregate now spans both repos.
      info = await (await fetch(`${base}/workspace`)).json();
      expect(info.repos.map((r: { name: string }) => r.name).sort()).toEqual([
        "alpha",
        "beta",
      ]);

      // The UI can also ask for only the active workspace, avoiding an expensive
      // aggregate summary when switching spaces.
      const scoped = await (
        await fetch(`${base}/workspace?workspace=${encodeURIComponent(repoB)}`)
      ).json();
      expect(scoped.root).toBe(repoB);
      expect(scoped.repos.map((r: { name: string }) => r.name)).toEqual(["beta"]);

      // A repeat lightweight registration is idempotent and avoids returning the
      // expensive workspace summary body used by the UI picker.
      const repeat = await fetch(`${base}/workspaces?summary=0`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: repoB }),
      });
      expect(repeat.status).toBe(204);

      // /workspaces breaks it down per registered path.
      const entries = await (await fetch(`${base}/workspaces`)).json();
      expect(entries).toHaveLength(2);
      expect(entries.flatMap((e: { repos: { name: string }[] }) =>
        e.repos.map((r) => r.name),
      ).sort()).toEqual(["alpha", "beta"]);

      // A thread filed in the added workspace shows in the aggregate feed.
      const post = await fetch(`${base}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: "beta", file: "f.txt", side: "new", line: 1, body: "hi" }),
      });
      expect(post.status).toBe(201);
      const threads = await (await fetch(`${base}/threads`)).json();
      expect(threads).toHaveLength(1);
      expect(threads[0].repo).toBe("beta");

      // Removing it drops beta from the aggregate (seed alpha remains).
      const del = await fetch(`${base}/workspaces`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: repoB }),
      });
      expect(del.status).toBe(200);
      info = await (await fetch(`${base}/workspace`)).json();
      expect(info.repos.map((r: { name: string }) => r.name)).toEqual(["alpha"]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("dedupes colliding repo basenames across workspaces and filters correctly", async () => {
    // Two single-repo workspaces whose repos share the basename "api".
    const apiA = join(scratch, "team-a", "api");
    const apiB = join(scratch, "team-b", "api");
    await initRepo(apiA);
    await initRepo(apiB);

    const server = await createServer({ workspacePath: apiA });
    const base = await listen(server);
    try {
      await fetch(`${base}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: apiB }),
      });
      const info = await (await fetch(`${base}/workspace`)).json();
      const names: string[] = info.repos.map((r: { name: string }) => r.name);
      expect(names).toHaveLength(2);
      expect(new Set(names).size).toBe(2); // globally unique

      // A scoped workspace summary must still use the aggregate repo name because
      // `/repos/:repo/*` routes resolve against the globally deduped aggregate.
      const scoped = await (
        await fetch(`${base}/workspace?workspace=${encodeURIComponent(apiB)}`)
      ).json();
      const second = names.find((n) => n !== "api") ?? names[1];
      expect(scoped.root).toBe(apiB);
      expect(scoped.repos.map((r: { name: string }) => r.name)).toEqual([second]);
      expect((await fetch(`${base}/repos/${encodeURIComponent(second)}/diff?target=work`)).status).toBe(200);

      // File a thread in the second (renamed) repo and filter by its current name.
      const post = await fetch(`${base}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: second, file: "f.txt", side: "new", line: 1, body: "x" }),
      });
      expect(post.status).toBe(201);
      const filtered = await (
        await fetch(`${base}/threads?repo=${encodeURIComponent(second)}`)
      ).json();
      expect(filtered).toHaveLength(1);
      expect(filtered[0].repo).toBe(second);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("rejects an unknown path with 400", async () => {
    const repoA = join(scratch, "alpha");
    await initRepo(repoA);
    const server = await createServer({ workspacePath: repoA });
    const base = await listen(server);
    try {
      const res = await fetch(`${base}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: join(scratch, "not-a-repo") }),
      });
      expect(res.status).toBe(400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("blocks workspace mutation on a non-loopback daemon (403)", async () => {
    const repoA = join(scratch, "alpha");
    const repoB = join(scratch, "beta");
    await initRepo(repoA);
    await initRepo(repoB);
    // Bind host is non-loopback; still listen on loopback so the test can reach it.
    const server = await createServer({ workspacePath: repoA, host: "0.0.0.0" });
    const base = await listen(server);
    try {
      const res = await fetch(`${base}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: repoB }),
      });
      expect(res.status).toBe(403);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
