import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadThreads, threadsLogPath } from "../src/reviews/event-log.js";
import { migrateLegacyStore } from "../src/store/migrate.js";

let repo: string;
const LEGACY_EVENT = JSON.stringify({
  v: 1,
  type: "thread.created",
  id: "th_legacy",
  ts: "2026-05-31T12:00:00.000Z",
  repo: "r",
  worktree: null,
  file: "a.ts",
  side: "new",
  line: 1,
  endLine: null,
  anchor: null,
  severity: null,
  author: { type: "user" },
  body: "from the old in-tree store",
});

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "diffect-migrate-"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function writeLegacy(content: string): Promise<void> {
  await mkdir(join(repo, ".reviews"), { recursive: true });
  await writeFile(join(repo, ".reviews", "threads.jsonl"), content, "utf8");
}

describe("legacy store migration", () => {
  it("copies a legacy in-tree log into the central store on first read", async () => {
    await writeLegacy(LEGACY_EVENT + "\n");

    const threads = await loadThreads(repo); // triggers lazy migration
    expect(threads.map((t) => t.id)).toEqual(["th_legacy"]);
    expect(existsSync(threadsLogPath(repo))).toBe(true);
  });

  it("never deletes the legacy file (kept as a backup)", async () => {
    await writeLegacy(LEGACY_EVENT + "\n");
    await migrateLegacyStore(repo);
    expect(existsSync(join(repo, ".reviews", "threads.jsonl"))).toBe(true);
  });

  it("is idempotent and does not clobber an existing central log", async () => {
    // Seed the central log, then a stale legacy file must not overwrite it.
    const central = threadsLogPath(repo);
    await mkdir(join(central, ".."), { recursive: true });
    await writeFile(central, LEGACY_EVENT + "\n", "utf8");

    await writeLegacy("{} should be ignored\n");
    await migrateLegacyStore(repo);

    expect(await readFile(central, "utf8")).toBe(LEGACY_EVENT + "\n");
  });

  it("is a no-op when there is no legacy store", async () => {
    await migrateLegacyStore(repo);
    expect(existsSync(threadsLogPath(repo))).toBe(false);
  });
});
