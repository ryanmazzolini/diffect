import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { normalizeTarget } from "../src/git/target.js";
import { resolveScope, sessionIdForScope } from "../src/reviews/scope.js";
import { discoverWorkspace, summarizeRepos } from "../src/workspace.js";

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

/** Advance HEAD by one commit so the session-stability check has something to move. */
async function commit(dir: string, text: string): Promise<void> {
  await writeFile(join(dir, "f.txt"), text);
  await git(dir, ["commit", "-am", "advance"]);
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "diffect-sessions-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("summarizeRepos session derivation", () => {
  // THE join-key guard: a surfaced session's id MUST equal the id the diff route
  // stamps for the same checkout. The diff route resolves the primary worktree as
  // `worktree=null`, so the sidebar must too — otherwise a comment's `sessionId`
  // never matches its session entry and the thread is orphaned.
  it("derives the primary work session with the same id the diff route stamps", async () => {
    const root = join(ws, "proj");
    await initRepo(root);
    await git(root, ["checkout", "-b", "feature"]);
    await commit(root, "changed\n");

    const w = await discoverWorkspace(ws);
    const [repo] = await summarizeRepos(w.repos);

    expect(repo!.sessions).toHaveLength(1);
    const session = repo!.sessions[0]!;
    expect(session.worktree).toBeNull(); // primary → null, never the basename
    expect(session.scope.headRef).toBe("feature");

    const expected = sessionIdForScope(
      await resolveScope(root, normalizeTarget("work"), null),
    );
    expect(session.id).toBe(expected);
  });

  it("keeps the derived session id stable as the branch advances", async () => {
    const root = join(ws, "proj");
    await initRepo(root);
    await git(root, ["checkout", "-b", "feature"]);
    await commit(root, "one\n");

    const first = (await summarizeRepos((await discoverWorkspace(ws)).repos))[0]!
      .sessions[0]!.id;
    await commit(root, "two\n"); // HEAD moves; the session identity must not.
    const second = (await summarizeRepos((await discoverWorkspace(ws)).repos))[0]!
      .sessions[0]!.id;

    expect(second).toBe(first);
  });

  it("derives a distinct session per checkout, each matching its own diff-route id", async () => {
    const primary = join(ws, "proj");
    await initRepo(primary);
    await git(primary, ["branch", "feature"]);
    await git(primary, ["worktree", "add", join(ws, "proj-feature"), "feature"]);

    const w = await discoverWorkspace(ws);
    const [repo] = await summarizeRepos(w.repos);

    expect(repo!.sessions).toHaveLength(2);
    const ids = new Set(repo!.sessions.map((s) => s.id));
    expect(ids.size).toBe(2); // no accidental dedup of distinct branches

    // The primary rides worktree=null; the linked checkout rides its own name —
    // each id must equal the diff route's resolution for that exact pair.
    for (const session of repo!.sessions) {
      const treeRoot = session.worktree
        ? join(ws, session.worktree)
        : primary;
      const expected = sessionIdForScope(
        await resolveScope(treeRoot, normalizeTarget("work"), session.worktree),
      );
      expect(session.id).toBe(expected);
    }
    const byWorktree = new Map(repo!.sessions.map((s) => [s.worktree, s]));
    expect(byWorktree.get(null)!.scope.headRef).toBe("main"); // primary on main
    expect(byWorktree.get("proj-feature")!.scope.headRef).toBe("feature");
  });

  it("labels a default-branch checkout as a local session (base === head)", async () => {
    const root = join(ws, "proj");
    await initRepo(root); // stays on the default branch `main`

    const [repo] = await summarizeRepos((await discoverWorkspace(ws)).repos);
    const { scope } = repo!.sessions[0]!;
    // work on the default branch diffs main..main — the local-state case.
    expect(scope.baseRef).toBe("main");
    expect(scope.headRef).toBe("main");
  });

  it("names a detached primary head by its directory, resolved as worktree=null", async () => {
    const root = join(ws, "proj");
    await initRepo(root);
    const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    await git(root, ["checkout", "--detach", head]);

    const [repo] = await summarizeRepos((await discoverWorkspace(ws)).repos);
    const session = repo!.sessions[0]!;
    expect(session.worktree).toBeNull();
    expect(session.scope.branch).toBeNull();
    // No branch to name → fall back to the tree basename, NOT a worktree key.
    expect(session.scope.headRef).toBe(`wt:${basename(root)}`);
  });
});
