import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { resolveWorkBase } from "../src/git/diff.js";
import { createThread } from "../src/reviews/event-log.js";
import { computeAnchor, readSideLines } from "../src/reviews/anchors.js";
import { loadRefreshedThreads } from "../src/reviews/refresh.js";
import { discoverWorkspace } from "../src/workspace.js";

let dir: string;
const T0 = "2026-05-31T12:00:00.000Z";

const SRC = ["one", "two", "three", "four", "five"].join("\n") + "\n";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "diffect-anchor-"));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "t@e.com"]);
  await git(dir, ["config", "user.name", "T"]);
  await writeFile(join(dir, "a.txt"), SRC);
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "base"]);
  // Put the file in the work diff (unstaged change to an unrelated line).
  await writeFile(join(dir, "a.txt"), SRC.replace("four", "FOUR"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Create a thread on a.txt:line with a real anchor, as the daemon/CLI would. */
async function comment(line: number) {
  const base = await resolveWorkBase(dir);
  const lines = await readSideLines(dir, "a.txt", "new", base);
  const anchor = computeAnchor(lines!, line, null, base);
  // Use the discovered repo name (basename), exactly as the daemon/CLI do, so
  // re-anchoring can resolve the repo on load.
  const ws = await discoverWorkspace(dir);
  const repo = ws.repos[0]!.name;
  return createThread(
    dir,
    { repo, file: "a.txt", side: "new", line, anchor, body: `c${line}` },
    T0,
  );
}

describe("re-anchoring against a real repo", () => {
  it("follows a comment when lines are inserted above it", async () => {
    const created = await comment(2); // "two"
    // Insert two lines at the top of the working tree.
    await writeFile(join(dir, "a.txt"), "zero\nhalf\n" + SRC.replace("four", "FOUR"));

    const ws = await discoverWorkspace(dir);
    const [t] = await loadRefreshedThreads(ws);
    expect(t!.id).toBe(created.id);
    expect(t!.anchorState).toBe("active");
    expect(t!.line).toBe(4); // "two" is now the 4th line
  });

  it("marks a comment stale when its line is deleted", async () => {
    await comment(2); // "two"
    await writeFile(join(dir, "a.txt"), "one\nthree\nFOUR\nfive\n"); // drop "two"

    const ws = await discoverWorkspace(dir);
    const [t] = await loadRefreshedThreads(ws);
    expect(t!.anchorState).toBe("stale");
  });

  it("marks a comment stale when the whole file is deleted", async () => {
    await comment(2);
    await rm(join(dir, "a.txt"));

    const ws = await discoverWorkspace(dir);
    const [t] = await loadRefreshedThreads(ws);
    expect(t!.anchorState).toBe("stale");
  });

  it("stays active+in-place when an unrelated line changes", async () => {
    await comment(2); // "two"; the fixture already changed "four"->"FOUR"
    const ws = await discoverWorkspace(dir);
    const [t] = await loadRefreshedThreads(ws);
    expect(t!.anchorState).toBe("active");
    expect(t!.line).toBe(2);
  });
});
