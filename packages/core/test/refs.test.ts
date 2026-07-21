import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { listRefs, searchRefs } from "../src/git/refs.js";
import { computeTargetDiff, normalizeTarget } from "../src/git/target.js";
import { resolveScope, sessionIdForScope } from "../src/reviews/scope.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "diffect-refs-"));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "t@e.com"]);
  await git(dir, ["config", "user.name", "T"]);
  await writeFile(join(dir, "a.txt"), "one\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "first commit"]);
  await git(dir, ["tag", "v1"]);
  await git(dir, ["branch", "feature"]);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("listRefs", () => {
  it("lists branches, tags, and recent commits", async () => {
    const refs = await listRefs(dir);
    expect(refs.branches.map((ref) => ref.label).sort()).toEqual(["feature", "main"]);
    expect(refs.tags.map((ref) => ref.label)).toEqual(["v1"]);
    expect(refs.remotes).toEqual([]);
    expect(refs.commits).toHaveLength(1);
    expect(refs.commitsReachRoot).toBe(true);
    expect(refs.commits[0]).toMatchObject({
      subject: "first commit",
      committer: "T",
    });
    expect(refs.commits[0]!.sha).toMatch(/^[0-9a-f]+$/);
    expect(refs.commits[0]!.shortSha).toMatch(/^[0-9a-f]+$/);
    expect(refs.commits[0]!.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("uses peeled commit metadata for annotated tags", async () => {
    await git(dir, ["tag", "-a", "v2", "-m", "release tag"]);
    const refs = await listRefs(dir);
    const tag = refs.tags.find((candidate) => candidate.label === "v2");
    expect(tag).toMatchObject({
      kind: "tag",
      value: "tags/v2",
      subject: "first commit",
      committer: "T",
    });
    expect(tag?.sha).toBe((await git(dir, ["rev-parse", "HEAD"])).stdout.trim());
  });

  it("hides the root boundary when recent commits do not reach it", async () => {
    for (let index = 0; index < 30; index += 1) {
      await writeFile(join(dir, "a.txt"), `revision ${index}\n`);
      await git(dir, ["commit", "-am", `revision ${index}`]);
    }

    const refs = await listRefs(dir);
    expect(refs.commits).toHaveLength(30);
    expect(refs.commitsReachRoot).toBe(false);
    expect(refs.commits.at(-1)?.subject).toBe("revision 0");
  });

  it("pages full and filtered commit history without loading it all", async () => {
    await git(dir, ["branch", "-D", "feature"]);
    await git(dir, ["tag", "-d", "v1"]);
    for (let index = 0; index < 25; index += 1) {
      await git(dir, ["commit", "--allow-empty", "-m", `paged topic ${index}`]);
    }

    const legacyLimit = await searchRefs(dir, "", 3);
    expect(legacyLimit.commits).toHaveLength(3);
    expect(legacyLimit.commitPage.limit).toBe(3);

    const newest = await searchRefs(dir, "", 5, { commitOffset: 0, commitLimit: 10 });
    expect(newest.commits).toHaveLength(10);
    expect(newest.commits[0]?.subject).toBe("paged topic 24");
    expect(newest.commitPage).toEqual({
      offset: 0,
      limit: 10,
      hasNewer: false,
      hasOlder: true,
    });

    const middle = await searchRefs(dir, "", 5, { commitOffset: 10, commitLimit: 10 });
    expect(middle.commits[0]?.subject).toBe("paged topic 14");
    expect(middle.commitPage).toEqual({
      offset: 10,
      limit: 10,
      hasNewer: true,
      hasOlder: true,
    });

    const oldestFiltered = await searchRefs(dir, "paged topic", 5, {
      commitOffset: 20,
      commitLimit: 10,
    });
    expect(oldestFiltered.commits.map((commit) => commit.subject)).toEqual([
      "paged topic 4",
      "paged topic 3",
      "paged topic 2",
      "paged topic 1",
      "paged topic 0",
    ]);
    expect(oldestFiltered.commitPage).toEqual({
      offset: 20,
      limit: 10,
      hasNewer: true,
      hasOlder: false,
    });
  });

  it("pages branches independently and keeps the default on the first page", async () => {
    for (let index = 0; index < 10; index += 1) {
      await git(dir, ["branch", `topic-${index}`]);
    }
    const { stdout } = await git(dir, ["rev-parse", "HEAD"]);
    await git(dir, ["branch", "release/stable"]);
    await git(dir, ["update-ref", "refs/remotes/origin/release/stable", stdout.trim()]);
    await git(dir, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/release/stable",
    ]);

    const first = await searchRefs(dir, "", 20, { branchLimit: 5 });
    const second = await searchRefs(dir, "", 20, { branchOffset: 5, branchLimit: 5 });
    const third = await searchRefs(dir, "", 20, { branchOffset: 10, branchLimit: 5 });
    expect(first.branches).toHaveLength(5);
    expect(first.branches[0]?.label).toBe("release/stable");
    expect(first.remotes[0]?.label).toBe("origin/release/stable");
    expect(first.branchPage).toEqual({ offset: 0, limit: 5, hasNewer: false, hasOlder: true });
    expect(second.branchPage).toEqual({ offset: 5, limit: 5, hasNewer: true, hasOlder: true });
    expect(third.branchPage).toEqual({ offset: 10, limit: 5, hasNewer: true, hasOlder: false });
    expect(new Set([
      ...first.branches,
      ...second.branches,
      ...third.branches,
    ].map((branch) => branch.value)).size).toBe(13);

    const filteredFirst = await searchRefs(dir, "topic-", 20, { branchLimit: 5 });
    const filteredSecond = await searchRefs(dir, "topic-", 20, {
      branchOffset: 5,
      branchLimit: 5,
    });
    expect(filteredFirst.branches).toHaveLength(5);
    expect(filteredFirst.branchPage.hasOlder).toBe(true);
    expect(filteredSecond.branches).toHaveLength(5);
    expect(filteredSecond.branchPage).toMatchObject({ hasNewer: true, hasOlder: false });
  });

  it("searches branches, tags, commit subjects, and SHA prefixes", async () => {
    await writeFile(join(dir, "a.txt"), "two\n");
    await git(dir, ["commit", "-am", "searchable topic"]);
    const { stdout } = await git(dir, ["rev-parse", "HEAD"]);
    const fullSha = stdout.trim();

    const branchMatches = await searchRefs(dir, "feat", 5);
    expect(branchMatches.branches[0]).toMatchObject({
      label: "feature",
      subject: "first commit",
      committer: "T",
      sha: expect.stringMatching(/^[0-9a-f]+$/),
    });
    expect(branchMatches.branches[0]!.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const tagMatches = await searchRefs(dir, "v1", 5);
    expect(tagMatches.tags[0]).toMatchObject({ label: "v1", value: "tags/v1" });

    const subjectMatches = await searchRefs(dir, "searchable", 5);
    expect(subjectMatches.commits[0]).toMatchObject({
      label: expect.stringMatching(/^[0-9a-f]+$/),
      subject: "searchable topic",
      sha: fullSha,
      value: fullSha,
    });

    const hashQuery = fullSha.slice(0, 8);
    const hashMatches = await searchRefs(dir, hashQuery, 5);
    expect(hashMatches.commits[0]).toMatchObject({ sha: fullSha });

    await git(dir, ["commit", "--allow-empty", "-m", `mentions ${hashQuery}`]);
    const exactPage = await searchRefs(dir, hashQuery, 5, {
      commitOffset: 0,
      commitLimit: 1,
    });
    expect(exactPage.commits[0]).toMatchObject({ sha: fullSha });
    expect(exactPage.commitPage.hasOlder).toBe(true);
    const subjectPage = await searchRefs(dir, hashQuery, 5, {
      commitOffset: 1,
      commitLimit: 1,
    });
    expect(subjectPage.commits[0]?.subject).toBe(`mentions ${hashQuery}`);
    expect(subjectPage.commitPage).toMatchObject({ hasNewer: true, hasOlder: false });
  });

  it("does not let a flag-like target inject a git option (argument injection)", async () => {
    const victim = join(dir, "victim.txt");
    await writeFile(victim, "important", "utf8");
    // Without --end-of-options this `--output=` would truncate the victim file.
    const target = normalizeTarget(`--output=${victim}`);
    await computeTargetDiff(dir, target).catch(() => {}); // bad ref may throw — fine
    expect(existsSync(victim)).toBe(true);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(victim, "utf8")).toBe("important");
  });
});

describe("Repo Start", () => {
  it("exposes the repository empty tree and includes the root commit", async () => {
    const refs = await listRefs(dir);
    expect(refs.repoStartSha).toMatch(/^[0-9a-f]{40}$/);

    const target = normalizeTarget(`${refs.repoStartSha}..HEAD`);
    const diff = await computeTargetDiff(dir, target);
    expect(diff.files.map((file) => file.path)).toEqual(["a.txt"]);
    expect(diff.files[0]?.status).toBe("added");

    const scope = await resolveScope(dir, target, null);
    expect(scope).toMatchObject({
      baseRef: refs.repoStartSha,
      headRef: "HEAD",
      baseSha: refs.repoStartSha,
    });
    expect(sessionIdForScope(await resolveScope(dir, target, null), null)).toBe(
      sessionIdForScope(scope, null),
    );
  });

  it("creates the empty tree for SHA-256 repositories", async () => {
    const sha256Dir = await mkdtemp(join(tmpdir(), "diffect-refs-sha256-"));
    try {
      await git(sha256Dir, ["init", "--object-format=sha256", "-b", "main"]);
      await git(sha256Dir, ["config", "user.email", "t@e.com"]);
      await git(sha256Dir, ["config", "user.name", "T"]);
      await writeFile(join(sha256Dir, "sha256.txt"), "content\n");
      await git(sha256Dir, ["add", "."]);
      await git(sha256Dir, ["commit", "-m", "root"]);

      const refs = await listRefs(sha256Dir);
      expect(refs.repoStartSha).toMatch(/^[0-9a-f]{64}$/);
      const target = normalizeTarget(`${refs.repoStartSha}..HEAD`);
      const diff = await computeTargetDiff(sha256Dir, target);
      expect(diff.files[0]).toMatchObject({ path: "sha256.txt", status: "added" });
    } finally {
      await rm(sha256Dir, { recursive: true, force: true });
    }
  });
});

describe("remote-tracking refs", () => {
  // update-ref / symbolic-ref fabricate the exact refs a `git fetch` would
  // create, without standing up a second repo: two remote branches plus the
  // symbolic origin/HEAD that aliases the default branch.
  async function fabricateOrigin(): Promise<void> {
    const { stdout } = await git(dir, ["rev-parse", "HEAD"]);
    const sha = stdout.trim();
    await git(dir, ["update-ref", "refs/remotes/origin/main", sha]);
    await git(dir, ["update-ref", "refs/remotes/origin/feature", sha]);
    await git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  }

  it("lists remote-tracking branches and drops the symbolic origin/HEAD", async () => {
    await fabricateOrigin();
    const refs = await listRefs(dir);
    expect(refs.remotes.map((ref) => ref.label).sort()).toEqual([
      "origin/feature",
      "origin/main",
    ]);
    expect(refs.remotes.some((ref) => ref.label === "origin/HEAD")).toBe(false);
  });

  it("pages remote branches independently and keeps the default on the first page", async () => {
    await fabricateOrigin();
    const { stdout } = await git(dir, ["rev-parse", "HEAD"]);
    for (let index = 0; index < 10; index += 1) {
      await git(dir, ["update-ref", `refs/remotes/origin/topic-${index}`, stdout.trim()]);
    }

    const first = await searchRefs(dir, "", 20, { remoteLimit: 5 });
    const second = await searchRefs(dir, "", 20, { remoteOffset: 5, remoteLimit: 5 });
    const third = await searchRefs(dir, "", 20, { remoteOffset: 10, remoteLimit: 5 });
    expect(first.remotes).toHaveLength(5);
    expect(first.remotes[0]?.label).toBe("origin/main");
    expect(first.remotePage).toEqual({ offset: 0, limit: 5, hasNewer: false, hasOlder: true });
    expect(second.remotePage).toEqual({ offset: 5, limit: 5, hasNewer: true, hasOlder: true });
    expect(third.remotePage).toEqual({ offset: 10, limit: 5, hasNewer: true, hasOlder: false });
    expect(new Set([
      ...first.remotes,
      ...second.remotes,
      ...third.remotes,
    ].map((remote) => remote.value)).size).toBe(12);
  });

  it("searches remotes under their own group, keeping bare names as values", async () => {
    await fabricateOrigin();
    // "origin" matches origin/HEAD too — the result must exclude it so a symbolic
    // alias never becomes a selectable compare point.
    const matches = await searchRefs(dir, "origin", 5);
    expect(matches.remotes.map((r) => r.label).sort()).toEqual([
      "origin/feature",
      "origin/main",
    ]);
    expect(matches.remotes.some((r) => r.value.endsWith("/HEAD"))).toBe(false);
    expect(matches.remotes.find((r) => r.label === "origin/main")).toMatchObject({
      kind: "remote",
      value: "origin/main",
      label: "origin/main",
    });
  });
});
