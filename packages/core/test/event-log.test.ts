import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addComment,
  createThread,
  deleteThread,
  dismissThread,
  loadThreads,
  replay,
  resolveThread,
  threadsLogPath,
  UnknownThreadError,
} from "../src/reviews/event-log.js";
import { THREAD_SCHEMA_VERSION } from "@diffect/shared";

let dir: string;
const T0 = "2026-05-31T12:00:00.000Z";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "diffect-log-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("event log", () => {
  it("creates the central threads log on first write and round-trips", async () => {
    const created = await createThread(
      dir,
      {
        repo: "repo",
        file: "src/a.ts",
        side: "new",
        line: 42,
        severity: "must-fix",
        body: "N+1 query here",
      },
      T0,
    );

    // File exists and holds one JSON event line.
    const raw = await readFile(threadsLogPath(dir), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]!);
    expect(event).toMatchObject({
      type: "thread.created",
      v: THREAD_SCHEMA_VERSION,
      file: "src/a.ts",
      line: 42,
    });

    // Replaying from disk reproduces the thread.
    const loaded = await loadThreads(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe(created.id);
    expect(loaded[0]!.status).toBe("open");
    expect(loaded[0]!.comments[0]).toMatchObject({
      author: { type: "user" },
      body: "N+1 query here",
    });
  });

  it("replays multiple created events deterministically", async () => {
    await createThread(dir, { repo: "r", file: "a", line: 1, body: "first" }, T0);
    await createThread(dir, { repo: "r", file: "b", line: 2, body: "second" }, T0);
    const loaded = await loadThreads(dir);
    expect(loaded.map((t) => t.comments[0]!.body)).toEqual(["first", "second"]);
  });

  it("returns no threads when the log is absent", async () => {
    expect(await loadThreads(dir)).toEqual([]);
  });

  it("appends comment + resolve and replays into one conversation", async () => {
    const t = await createThread(
      dir,
      { repo: "r", file: "a", line: 1, body: "N+1 here" },
      T0,
    );
    await addComment(
      dir,
      t.id,
      { author: { type: "agent", name: "pi" }, body: "batched via dataloader" },
      T0,
    );
    const resolved = await resolveThread(
      dir,
      t.id,
      { author: { type: "user" }, summary: "verified" },
      T0,
    );
    expect(resolved.status).toBe("resolved");

    const [loaded] = await loadThreads(dir);
    expect(loaded!.status).toBe("resolved");
    // original + agent reply + resolution note (recorded as a trailing comment)
    expect(loaded!.comments.map((c) => c.body)).toEqual([
      "N+1 here",
      "batched via dataloader",
      "verified",
    ]);
    expect(loaded!.comments[1]!.author).toEqual({ type: "agent", name: "pi" });
  });

  it("dismiss records a reason and sets status", async () => {
    const t = await createThread(dir, { repo: "r", file: "a", line: 1, body: "x" }, T0);
    const d = await dismissThread(
      dir,
      t.id,
      { author: { type: "user" }, reason: "wontfix" },
      T0,
    );
    expect(d.status).toBe("dismissed");
    expect(d.comments.at(-1)!.body).toBe("wontfix");
  });

  it("deletes a thread via tombstone so it vanishes from replay", async () => {
    const t = await createThread(dir, { repo: "r", file: "a", line: 1, body: "x" }, T0);
    await dismissThread(dir, t.id, { author: { type: "user" }, reason: "wontfix" }, T0);
    await deleteThread(dir, t.id, { author: { type: "user" } }, T0);
    expect(await loadThreads(dir)).toEqual([]);
  });

  it("replay drops a thread that has a thread.deleted tombstone", () => {
    const base = {
      v: THREAD_SCHEMA_VERSION,
      ts: T0,
      author: { type: "user" as const },
    };
    const created = {
      ...base,
      type: "thread.created" as const,
      id: "th_d",
      repo: "r",
      worktree: null,
      file: "a",
      side: "new" as const,
      line: 1,
      endLine: null,
      anchor: null,
      severity: null,
      body: "doomed",
    };
    const deleted = { ...base, type: "thread.deleted" as const, thread: "th_d" };
    const late = {
      ...base,
      type: "comment.added" as const,
      thread: "th_d",
      commentId: "c_late",
      body: "after the tombstone",
    };
    expect(replay([created, deleted])).toEqual([]);
    // Merge reorder: a tombstone (and a trailing comment) before thread.created
    // must NOT resurrect the thread — two-pass replay deletes it in pass 2.
    expect(replay([deleted, created])).toEqual([]);
    expect(replay([deleted, created, late])).toEqual([]);
  });

  it("rejects deleting an unknown thread", async () => {
    await expect(
      deleteThread(dir, "th_missing", { author: { type: "user" } }, T0),
    ).rejects.toBeInstanceOf(UnknownThreadError);
  });

  it("rejects a mutation targeting an unknown thread", async () => {
    await expect(
      addComment(dir, "th_missing", { body: "x" }, T0),
    ).rejects.toBeInstanceOf(UnknownThreadError);
  });

  it("ignores events from an unknown schema version on replay", () => {
    const good = {
      v: THREAD_SCHEMA_VERSION,
      type: "thread.created" as const,
      id: "th_1",
      ts: T0,
      repo: "r",
      worktree: null,
      file: "a",
      side: "new" as const,
      line: 1,
      endLine: null,
      anchor: null,
      severity: null,
      author: { type: "user" as const },
      body: "ok",
    };
    expect(replay([good])).toHaveLength(1);
  });

  it("applies a mutation that appears before its thread.created (merge reorder)", () => {
    // A git merge can interleave appended lines so a comment.added lands above
    // the thread.created it targets. Two-pass replay must still apply it.
    const created = {
      v: THREAD_SCHEMA_VERSION,
      type: "thread.created" as const,
      id: "th_x",
      ts: "2026-05-31T12:00:00.000Z",
      repo: "r",
      worktree: null,
      file: "a",
      side: "new" as const,
      line: 1,
      endLine: null,
      anchor: null,
      severity: null,
      author: { type: "user" as const },
      body: "first",
    };
    const reply = {
      v: THREAD_SCHEMA_VERSION,
      type: "comment.added" as const,
      ts: "2026-05-31T12:01:00.000Z",
      thread: "th_x",
      commentId: "c_1",
      author: { type: "agent" as const, name: "pi" },
      body: "reply before create in the log",
    };
    // reply is listed BEFORE created.
    const [t] = replay([reply, created]);
    expect(t!.comments.map((c) => c.body)).toEqual([
      "first",
      "reply before create in the log",
    ]);
    // updatedAt reflects the later event even though it came first in the array.
    expect(t!.updatedAt).toBe("2026-05-31T12:01:00.000Z");
  });
});
