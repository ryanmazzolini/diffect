import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { computeTargetDiff, normalizeTarget } from "../src/git/target.js";

describe("normalizeTarget", () => {
  it("defaults to work", () => {
    expect(normalizeTarget(undefined)).toMatchObject({ kind: "work" });
    expect(normalizeTarget("")).toMatchObject({ kind: "work" });
    expect(normalizeTarget("work")).toMatchObject({ kind: "work" });
  });
  it("recognizes staged/unstaged keywords", () => {
    expect(normalizeTarget("staged").kind).toBe("staged");
    expect(normalizeTarget("--cached").kind).toBe("staged");
    expect(normalizeTarget("unstaged").kind).toBe("unstaged");
  });
  it("parses a single ref", () => {
    expect(normalizeTarget("main")).toMatchObject({ kind: "ref", from: "main" });
  });
  it("distinguishes two-dot from three-dot ranges", () => {
    expect(normalizeTarget("main..feature")).toMatchObject({
      kind: "range",
      from: "main",
      to: "feature",
      threeDot: false,
    });
    expect(normalizeTarget("main...feature")).toMatchObject({
      kind: "range",
      from: "main",
      to: "feature",
      threeDot: true,
    });
  });
});

describe("computeTargetDiff", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "diffect-tgt-"));
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.email", "t@e.com"]);
    await git(dir, ["config", "user.name", "T"]);
    await writeFile(join(dir, "a.txt"), "1\n2\n3\n");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "base"]);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("staged shows only index-vs-HEAD changes", async () => {
    await writeFile(join(dir, "staged.txt"), "s\n");
    await git(dir, ["add", "staged.txt"]);
    await writeFile(join(dir, "unstaged.txt"), "u\n"); // untracked

    const diff = await computeTargetDiff(dir, normalizeTarget("staged"));
    const paths = diff.files.map((f) => f.path);
    expect(paths).toContain("staged.txt");
    expect(paths).not.toContain("unstaged.txt");
  });

  it("unstaged shows worktree changes + untracked, not staged-only adds", async () => {
    await writeFile(join(dir, "a.txt"), "1\nCHANGED\n3\n"); // unstaged edit
    await writeFile(join(dir, "new.txt"), "n\n"); // untracked
    await writeFile(join(dir, "indexed.txt"), "i\n");
    await git(dir, ["add", "indexed.txt"]); // staged-only

    const diff = await computeTargetDiff(dir, normalizeTarget("unstaged"));
    const paths = diff.files.map((f) => f.path);
    expect(paths).toContain("a.txt");
    expect(paths).toContain("new.txt");
    expect(paths).not.toContain("indexed.txt");
  });

  it("an explicit branch base compares its tip to the working tree after divergence", async () => {
    await git(dir, ["branch", "feature"]);
    await writeFile(join(dir, "main-only.txt"), "main\n");
    await git(dir, ["add", "main-only.txt"]);
    await git(dir, ["commit", "-m", "advance main"]);
    await git(dir, ["checkout", "-q", "feature"]);
    await writeFile(join(dir, "local.txt"), "local\n");

    const explicit = await computeTargetDiff(dir, normalizeTarget("main"));
    const explicitPaths = explicit.files.map((file) => file.path);
    expect(explicitPaths).toContain("main-only.txt");
    expect(explicitPaths).toContain("local.txt");

    // The legacy work target starts at the merge base and therefore cannot
    // represent the branch-tip comparison promised by the picker.
    const mergeBase = await computeTargetDiff(dir, normalizeTarget("work"));
    expect(mergeBase.files.map((file) => file.path)).not.toContain("main-only.txt");
  });

  it("a commit range shows committed changes only, ignoring the worktree", async () => {
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(join(dir, "a.txt"), "1\n2\n3\n4\n");
    await git(dir, ["commit", "-qam", "add 4"]);
    await writeFile(join(dir, "a.txt"), "1\n2\n3\n4\n5\n"); // dirty worktree

    const diff = await computeTargetDiff(dir, normalizeTarget("main..feature"));
    const added = diff.files
      .flatMap((f) => f.hunks)
      .flatMap((h) => h.lines)
      .filter((l) => l.type === "add")
      .map((l) => l.text);
    expect(added).toContain("4");
    expect(added).not.toContain("5");
  });
});
