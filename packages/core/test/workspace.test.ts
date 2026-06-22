import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import {
  discoverWorkspace,
  findRepo,
  resolveRepoRoot,
  summarizeRepos,
} from "../src/workspace.js";

let ws: string;

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "t@e.com"]);
  await git(dir, ["config", "user.name", "T"]);
  await writeFile(join(dir, "f.txt"), "hello\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "base"]);
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "diffect-ws-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("workspace discovery", () => {
  it("finds a single repo when the workspace root is itself a repo", async () => {
    await initRepo(ws);
    const w = await discoverWorkspace(ws);
    expect(w.repos).toHaveLength(1);
    expect(w.repos[0]!.worktrees).toHaveLength(1);
    expect(w.repos[0]!.name).not.toBe(".");
  });

  it("discovers multiple repos under a container workspace", async () => {
    await initRepo(join(ws, "api"));
    await initRepo(join(ws, "web"));
    const w = await discoverWorkspace(ws);
    expect(w.repos.map((r) => r.name).sort()).toEqual(["api", "web"]);
    expect(resolveRepoRoot(w, "api", null)).toBe(join(ws, "api"));
    expect(resolveRepoRoot(w, "web", null)).toBe(join(ws, "web"));
  });

  it("groups linked worktrees of one repo into a single repo entry", async () => {
    const primary = join(ws, "proj");
    await initRepo(primary);
    await git(primary, ["branch", "feature"]);
    await git(primary, ["worktree", "add", join(ws, "proj-feature"), "feature"]);

    const w = await discoverWorkspace(ws);
    expect(w.repos).toHaveLength(1);
    const repo = w.repos[0]!;
    expect(repo.worktrees.length).toBe(2);
    const names = repo.worktrees.map((t) => t.name).sort();
    expect(names).toContain("proj");
    expect(names).toContain("proj-feature");
    expect(resolveRepoRoot(w, repo.name, "proj-feature")).toBe(
      join(ws, "proj-feature"),
    );
  });

  it("disambiguates two repos that share a directory basename", async () => {
    await initRepo(join(ws, "frontend", "api"));
    await initRepo(join(ws, "backend", "api"));
    const w = await discoverWorkspace(ws);
    expect(w.repos).toHaveLength(2);
    const names = w.repos.map((r) => r.name);
    expect(new Set(names).size).toBe(2);
    for (const r of w.repos) {
      expect(resolveRepoRoot(w, r.name, null)).toBe(r.root);
    }
  });

  it("summarizes each worktree's current branch, null when detached", async () => {
    const primary = join(ws, "proj");
    await initRepo(primary);
    await git(primary, ["branch", "feature"]);
    await git(primary, ["worktree", "add", join(ws, "proj-feature"), "feature"]);
    // Detach the primary checkout's HEAD so its branch reads as null.
    const head = (await git(primary, ["rev-parse", "HEAD"])).stdout.trim();
    await git(primary, ["checkout", "--detach", head]);

    const w = await discoverWorkspace(ws);
    const [repo] = await summarizeRepos(w.repos);
    const byName = new Map(repo!.worktrees.map((t) => [t.name, t.branch]));
    expect(byName.get("proj")).toBeNull(); // detached
    expect(byName.get("proj-feature")).toBe("feature");
  });

  it("throws when no repo is present", async () => {
    await expect(discoverWorkspace(ws)).rejects.toThrow(/No git repository/);
  });

  it("findRepo / resolveRepoRoot return undefined for unknown ids", async () => {
    await initRepo(ws);
    const w = await discoverWorkspace(ws);
    expect(findRepo(w, "nope")).toBeUndefined();
    expect(resolveRepoRoot(w, "nope", null)).toBeUndefined();
    expect(resolveRepoRoot(w, w.repos[0]!.name, "nope")).toBeUndefined();
  });
});
