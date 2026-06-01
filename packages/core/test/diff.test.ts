import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { computeWorkDiff, parseUnifiedDiff } from "../src/git/diff.js";

let dir: string;

async function init(repo: string): Promise<void> {
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "diffect-diff-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("computeWorkDiff (work target)", () => {
  it("includes committed-since-base, unstaged, and untracked changes", async () => {
    await init(dir);

    // Base commit on main.
    await writeFile(join(dir, "base.txt"), "one\ntwo\nthree\n");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "base"]);

    // A second commit (committed-since-base) on a feature branch.
    await git(dir, ["checkout", "-b", "feature"]);
    await writeFile(join(dir, "base.txt"), "one\nTWO\nthree\n");
    await git(dir, ["commit", "-am", "edit two"]);

    // An unstaged change to a tracked file.
    await writeFile(join(dir, "base.txt"), "one\nTWO\nTHREE\n");

    // An untracked new file.
    await writeFile(join(dir, "new.txt"), "fresh\nlines\n");

    const diff = await computeWorkDiff(dir);
    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]));

    expect(diff.target).toBe("work");
    // Tracked file shows committed + unstaged edits against the base.
    expect(byPath["base.txt"]).toBeDefined();
    const newText = byPath["base.txt"]!.hunks.flatMap((h) =>
      h.lines.filter((l) => l.type === "add").map((l) => l.text),
    );
    expect(newText).toContain("TWO");
    expect(newText).toContain("THREE");

    // Untracked file shows as an all-added synthetic diff.
    expect(byPath["new.txt"]).toBeDefined();
    expect(byPath["new.txt"]!.status).toBe("untracked");
    expect(byPath["new.txt"]!.hunks[0]!.lines.map((l) => l.text)).toEqual([
      "fresh",
      "lines",
    ]);
  });

  it("handles a repo with no commits (everything untracked)", async () => {
    await init(dir);
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "a.txt"), "hello\n");
    const diff = await computeWorkDiff(dir);
    expect(diff.files.map((f) => f.path)).toContain("sub/a.txt");
  });

  it("never surfaces the .reviews/ store as untracked work", async () => {
    await init(dir);
    await writeFile(join(dir, "a.txt"), "x\n");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "base"]);
    // A real source change plus a (non-gitignored) review store write.
    await writeFile(join(dir, "a.txt"), "X\n");
    await mkdir(join(dir, ".reviews"), { recursive: true });
    await writeFile(join(dir, ".reviews", "threads.jsonl"), "{}\n");

    const paths = (await computeWorkDiff(dir)).files.map((f) => f.path);
    expect(paths).toContain("a.txt");
    expect(paths.some((p) => p.startsWith(".reviews"))).toBe(false);
  });
});

describe("parseUnifiedDiff", () => {
  it("parses hunk headers and line sides", () => {
    const raw = [
      "diff --git a/f.txt b/f.txt",
      "index 111..222 100644",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
    ].join("\n");
    const [file] = parseUnifiedDiff(raw);
    expect(file!.path).toBe("f.txt");
    expect(file!.hunks).toHaveLength(1);
    const h = file!.hunks[0]!;
    expect(h.oldStart).toBe(1);
    expect(h.newStart).toBe(1);
    const del = h.lines.find((l) => l.type === "del")!;
    const add = h.lines.find((l) => l.type === "add")!;
    expect(del).toMatchObject({ old: 2, new: null, text: "two" });
    expect(add).toMatchObject({ old: null, new: 2, text: "TWO" });
  });

  it("marks new and deleted files", () => {
    const added = parseUnifiedDiff(
      [
        "diff --git a/n.txt b/n.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/n.txt",
        "@@ -0,0 +1,1 @@",
        "+hi",
      ].join("\n"),
    );
    expect(added[0]).toMatchObject({ path: "n.txt", status: "added" });

    const deleted = parseUnifiedDiff(
      [
        "diff --git a/d.txt b/d.txt",
        "deleted file mode 100644",
        "--- a/d.txt",
        "+++ /dev/null",
        "@@ -1,1 +0,0 @@",
        "-bye",
      ].join("\n"),
    );
    expect(deleted[0]).toMatchObject({ path: "d.txt", status: "deleted" });
  });

  it("parses renames", () => {
    const [file] = parseUnifiedDiff(
      [
        "diff --git a/old.txt b/new.txt",
        "similarity index 100%",
        "rename from old.txt",
        "rename to new.txt",
      ].join("\n"),
    );
    expect(file).toMatchObject({
      path: "new.txt",
      oldPath: "old.txt",
      status: "renamed",
    });
  });

  it("handles paths containing spaces without dropping the prefix wrongly", () => {
    const [file] = parseUnifiedDiff(
      [
        "diff --git a/my dir/a file.txt b/my dir/a file.txt",
        "--- a/my dir/a file.txt",
        "+++ b/my dir/a file.txt",
        "@@ -1 +1 @@",
        "-x",
        "+y",
      ].join("\n"),
    );
    expect(file!.path).toBe("my dir/a file.txt");
  });

  it("does not over-strip a top-level dir literally named 'b'", () => {
    const [file] = parseUnifiedDiff(
      [
        "diff --git a/b/keep.txt b/b/keep.txt",
        "--- a/b/keep.txt",
        "+++ b/b/keep.txt",
        "@@ -1 +1 @@",
        "-x",
        "+y",
      ].join("\n"),
    );
    // After stripping the `b/` side-prefix, the real `b/` dir must remain.
    expect(file!.path).toBe("b/keep.txt");
  });

  it("unquotes C-quoted unicode paths", () => {
    const [file] = parseUnifiedDiff(
      [
        'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
        '--- "a/caf\\303\\251.txt"',
        '+++ "b/caf\\303\\251.txt"',
        "@@ -1 +1 @@",
        "-x",
        "+y",
      ].join("\n"),
    );
    expect(file!.path).toBe("café.txt");
  });
});
