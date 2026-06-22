import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { normalizeTarget } from "../src/git/target.js";
import {
  resolveScope,
  sessionIdForScope,
  snapshotIdForState,
} from "../src/reviews/scope.js";

let dir: string;

async function initRepo(d: string): Promise<void> {
  await mkdir(d, { recursive: true });
  await git(d, ["init", "-b", "main"]);
  await git(d, ["config", "user.email", "t@e.com"]);
  await git(d, ["config", "user.name", "T"]);
  await writeFile(join(d, "f.txt"), "hello\n");
  await git(d, ["add", "."]);
  await git(d, ["commit", "-m", "base"]);
}

/** Commit a one-line change so HEAD advances. */
async function commit(d: string, text: string): Promise<void> {
  await writeFile(join(d, "f.txt"), text);
  await git(d, ["commit", "-am", "advance"]);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "diffect-scope-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveScope", () => {
  it("binds a work target on a feature branch to a merge-base session", async () => {
    await initRepo(dir);
    await git(dir, ["checkout", "-b", "feature"]);
    await commit(dir, "changed\n");

    const scope = await resolveScope(dir, normalizeTarget("work"), null);
    expect(scope.kind).toBe("work");
    expect(scope.baseRef).toBe("main"); // diffed against the default branch
    expect(scope.headRef).toBe("feature");
    expect(scope.branch).toBe("feature");
    // baseSha is the merge-base (the base commit), not feature's HEAD.
    const base = (await git(dir, ["rev-parse", "main"])).stdout.trim();
    expect(scope.baseSha).toBe(base);
  });

  it("keeps the session id stable as the branch advances", async () => {
    await initRepo(dir);
    await git(dir, ["checkout", "-b", "feature"]);
    await commit(dir, "one\n");
    const first = sessionIdForScope(await resolveScope(dir, normalizeTarget("work"), null));

    await commit(dir, "two\n"); // HEAD moves; the session identity must not.
    const second = sessionIdForScope(await resolveScope(dir, normalizeTarget("work"), null));

    expect(second).toBe(first);
  });

  it("names a detached work head by its worktree instead of a branch", async () => {
    await initRepo(dir);
    const head = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    await git(dir, ["checkout", "--detach", head]);

    const scope = await resolveScope(dir, normalizeTarget("work"), "wt-a");
    expect(scope.branch).toBeNull();
    expect(scope.headRef).toBe("wt:wt-a");
  });

  it("resolves staged and unstaged against HEAD", async () => {
    await initRepo(dir);
    const head = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();

    const staged = await resolveScope(dir, normalizeTarget("staged"), null);
    expect(staged).toMatchObject({ kind: "staged", baseRef: "HEAD", headRef: "index" });
    expect(staged.baseSha).toBe(head);

    const unstaged = await resolveScope(dir, normalizeTarget("unstaged"), null);
    expect(unstaged).toMatchObject({
      kind: "unstaged",
      baseRef: "index",
      headRef: "worktree",
    });
  });

  it("resolves a range target to its endpoints", async () => {
    await initRepo(dir);
    await git(dir, ["checkout", "-b", "feature"]);
    await commit(dir, "changed\n");

    const scope = await resolveScope(dir, normalizeTarget("main..feature"), null);
    expect(scope).toMatchObject({
      kind: "range",
      baseRef: "main",
      headRef: "feature",
      target: "main..feature",
    });
    expect(scope.baseSha).toBe((await git(dir, ["rev-parse", "main"])).stdout.trim());
  });
});

describe("sessionIdForScope", () => {
  const base = {
    target: "x",
    baseRef: "main",
    headRef: "feature",
    baseSha: null,
    branch: null,
  };

  it("is deterministic for the same symbolic identity", () => {
    const a = sessionIdForScope({ ...base, kind: "range" });
    const b = sessionIdForScope({ ...base, kind: "range" });
    expect(a).toBe(b);
    expect(a).toMatch(/^sess_[0-9a-f]{16}$/);
  });

  it("distinguishes kinds that share a base/head pair", () => {
    // work vs range with identical refs must not collapse into one session.
    const work = sessionIdForScope({ ...base, kind: "work" });
    const range = sessionIdForScope({ ...base, kind: "range" });
    expect(work).not.toBe(range);
  });

  it("ignores resolved sha/branch (symbolic identity only)", () => {
    const a = sessionIdForScope({ ...base, kind: "work", baseSha: "aaaa", branch: "x" });
    const b = sessionIdForScope({ ...base, kind: "work", baseSha: "bbbb", branch: "y" });
    expect(a).toBe(b);
  });
});

describe("snapshotIdForState", () => {
  it("is stable across reruns of identical state", async () => {
    await initRepo(dir);
    const scope = await resolveScope(dir, normalizeTarget("work"), null);
    const a = await snapshotIdForState(dir, scope);
    const b = await snapshotIdForState(dir, scope);
    expect(a).toMatch(/^snap_[0-9a-f]{16}$/);
    expect(b).toBe(a); // pure read — same git state ⇒ same id
  });

  it("changes on a tracked worktree edit and again when it is staged", async () => {
    await initRepo(dir);
    const scope = await resolveScope(dir, normalizeTarget("work"), null);
    const clean = await snapshotIdForState(dir, scope);

    await writeFile(join(dir, "f.txt"), "hello edited\n"); // unstaged edit
    const dirty = await snapshotIdForState(dir, scope);
    expect(dirty).not.toBe(clean);

    await git(dir, ["add", "f.txt"]); // staging moves the change index-side
    const staged = await snapshotIdForState(dir, scope);
    expect(staged).not.toBe(dirty); // write-tree (index) now differs from the unstaged hash
    expect(staged).not.toBe(clean);
  });

  it("includes untracked files for the work kind but not for staged", async () => {
    await initRepo(dir);
    const work = await resolveScope(dir, normalizeTarget("work"), null);
    const staged = await resolveScope(dir, normalizeTarget("staged"), null);
    const workBefore = await snapshotIdForState(dir, work);
    const stagedBefore = await snapshotIdForState(dir, staged);

    await writeFile(join(dir, "new.txt"), "brand new\n"); // untracked file
    // `work` is the only diff that surfaces untracked, so only its snapshot moves.
    expect(await snapshotIdForState(dir, work)).not.toBe(workBefore);
    expect(await snapshotIdForState(dir, staged)).toBe(stagedBefore);
  });

  it("distinguishes snapshots of different scopes on identical state", async () => {
    await initRepo(dir);
    // Same worktree state, different symbolic refs ⇒ different snapshots (a
    // snapshot belongs to one review, never silently shared across targets).
    const work = await snapshotIdForState(dir, await resolveScope(dir, normalizeTarget("work"), null));
    const staged = await snapshotIdForState(dir, await resolveScope(dir, normalizeTarget("staged"), null));
    expect(work).not.toBe(staged);
  });

  it("returns null when there is no commit to anchor against", async () => {
    await mkdir(dir, { recursive: true });
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.email", "t@e.com"]);
    await git(dir, ["config", "user.name", "T"]);
    // Unborn HEAD: rev-parse HEAD fails, so a snapshot can't be anchored.
    const scope = await resolveScope(dir, normalizeTarget("staged"), null);
    expect(await snapshotIdForState(dir, scope)).toBeNull();
  });
});
