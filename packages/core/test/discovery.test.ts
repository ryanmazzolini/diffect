import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listDir, recommendations } from "../src/store/discovery.js";
import { createServer } from "../src/daemon.js";
import { git } from "../src/git/exec.js";

let home: string;
let prevHome: string | undefined;

async function mkRepo(path: string) {
  await mkdir(join(path, ".git"), { recursive: true });
}

/** Write a session log whose head carries the project's cwd, with a set mtime. */
async function mkSession(dir: string, cwd: string, mtimeSec: number) {
  await mkdir(dir, { recursive: true });
  const f = join(dir, "session.jsonl");
  await writeFile(f, `{"type":"session"}\n{"cwd":${JSON.stringify(cwd)}}\n`);
  await utimes(f, mtimeSec, mtimeSec);
}

beforeEach(async () => {
  prevHome = process.env.HOME;
  home = await mkdtemp(join(tmpdir(), "diffect-disco-"));
  process.env.HOME = home;
});
afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

describe("recommendations", () => {
  it("ranks recent git-repo projects from claude + pi, newest first", async () => {
    const alpha = join(home, "git", "alpha");
    const beta = join(home, "git", "beta");
    await mkRepo(alpha);
    await mkRepo(beta);
    const plain = join(home, "git", "plain"); // a real dir, but not a git repo
    await mkdir(plain, { recursive: true });

    await mkSession(join(home, ".claude", "projects", "-home-x-alpha"), alpha, 1000);
    await mkSession(join(home, ".pi", "agent", "sessions", "--home-x-beta--"), beta, 2000);
    // Points at a non-git dir → filtered out.
    await mkSession(join(home, ".claude", "projects", "-home-x-plain"), plain, 1500);
    // pi tmp test session → skipped (else alpha would jump to newest).
    await mkSession(join(home, ".pi", "agent", "sessions", "--tmp-TestRun--"), alpha, 9000);

    const recs = await recommendations();
    expect(recs.map((r) => r.path)).toEqual([beta, alpha]);
    expect(recs[0]).toMatchObject({ name: "beta", source: "pi" });
    expect(recs.some((r) => r.path === plain)).toBe(false);
  });

  it("survives a malformed session log and still returns the others", async () => {
    const good = join(home, "git", "good");
    await mkRepo(good);
    await mkSession(join(home, ".claude", "projects", "-good"), good, 1000);
    // A log whose cwd value has an invalid escape — JSON.parse would throw.
    const bad = join(home, ".claude", "projects", "-bad");
    await mkdir(bad, { recursive: true });
    await writeFile(join(bad, "s.jsonl"), '{"cwd":"/a\\xb"}\n');

    const recs = await recommendations();
    expect(recs.map((r) => r.path)).toEqual([good]);
  });

});

describe("listDir", () => {
  it("lists home subdirectories, hiding dotfiles and files", async () => {
    await mkdir(join(home, "projects"), { recursive: true });
    await mkdir(join(home, ".hidden"), { recursive: true });
    await writeFile(join(home, "note.txt"), "x");

    const listing = await listDir();
    expect(listing.parent).toBeNull();
    const names = listing.entries.map((e) => e.name);
    expect(names).toContain("projects");
    expect(names).not.toContain(".hidden");
    expect(names).not.toContain("note.txt");
  });

  it("refuses to browse outside the home directory", async () => {
    await expect(listDir("/etc")).rejects.toThrow();
  });

  it("refuses to follow a symlink that escapes home", async () => {
    const escape = join(home, "escape");
    await symlink("/etc", escape); // a symlink under home pointing outside it
    await expect(listDir(escape)).rejects.toThrow();
  });
});

describe("discovery routes", () => {
  it("are gated to a loopback-bound daemon", async () => {
    const repo = join(home, "ws");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "-b", "main"]);
    const server = await createServer({ workspacePath: repo, host: "0.0.0.0" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await fetch(`${base}/recommendations`)).status).toBe(403);
    expect((await fetch(`${base}/fs/list`)).status).toBe(403);
    await new Promise<void>((r) => server.close(() => r()));
  });
});
