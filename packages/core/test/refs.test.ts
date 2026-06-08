import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { listRefs, searchRefs } from "../src/git/refs.js";
import { computeTargetDiff, normalizeTarget } from "../src/git/target.js";

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
    expect(refs.branches.sort()).toEqual(["feature", "main"]);
    expect(refs.tags).toEqual(["v1"]);
    expect(refs.commits).toHaveLength(1);
    expect(refs.commits[0]!.subject).toBe("first commit");
    expect(refs.commits[0]!.sha).toMatch(/^[0-9a-f]+$/);
  });

  it("searches branches, tags, commit subjects, and SHA prefixes", async () => {
    await writeFile(join(dir, "a.txt"), "two\n");
    await git(dir, ["commit", "-am", "searchable topic"]);
    const { stdout } = await git(dir, ["rev-parse", "HEAD"]);
    const fullSha = stdout.trim();

    const branchMatches = await searchRefs(dir, "feat", 5);
    expect(branchMatches.branches.map((r) => r.label)).toContain("feature");

    const tagMatches = await searchRefs(dir, "v1", 5);
    expect(tagMatches.tags[0]).toMatchObject({ label: "v1", value: "tags/v1" });

    const subjectMatches = await searchRefs(dir, "searchable", 5);
    expect(subjectMatches.commits[0]).toMatchObject({
      label: expect.stringMatching(/^[0-9a-f]+$/),
      subject: "searchable topic",
      sha: fullSha,
      value: fullSha,
    });

    const hashMatches = await searchRefs(dir, fullSha.slice(0, 8), 5);
    expect(hashMatches.commits[0]).toMatchObject({ sha: fullSha });
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
