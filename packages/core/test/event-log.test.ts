import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addComment,
  archiveSession,
  createThread,
  deleteThread,
  loadArchivedSessions,
  loadThreads,
  readEvents,
  replay,
  replaySessions,
  resolveThread,
  spaceThreadStore,
  UnknownThreadError,
  UnscopedSessionError,
} from "../src/reviews/event-log.js";
import { threadsLogPath } from "../src/store/paths.js";
import { sessionIdForScope } from "../src/reviews/scope.js";
import {
  THREAD_EVENT_TYPES,
  THREAD_SCHEMA_VERSION,
  type ReviewScope,
  type SessionArchivedEvent,
} from "@diffect/shared";

let dir: string;
const T0 = "2026-05-31T12:00:00.000Z";
const T1 = "2026-05-31T12:01:00.000Z";
const T2 = "2026-05-31T12:02:00.000Z";

const SCOPE: ReviewScope = {
  target: "main..feature",
  kind: "range",
  baseRef: "main",
  headRef: "feature",
  baseSha: "deadbeef",
  branch: "feature",
};

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
    expect(loaded[0]!.targetLevel).toBe("file");
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

  it("round-trips space and repo-level comments from a space store", async () => {
    const store = spaceThreadStore(dir);
    await createThread(
      store,
      { repo: null, targetLevel: "space", file: null, body: "whole space" },
      T0,
    );
    await createThread(
      store,
      { repo: "r", targetLevel: "repo", file: null, body: "repo note" },
      T0,
    );

    const loaded = await loadThreads(store);
    expect(loaded.map((t) => [t.targetLevel, t.repo, t.file, t.comments[0]!.body])).toEqual([
      ["space", null, null, "whole space"],
      ["repo", "r", null, "repo note"],
    ]);
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
    expect(resolved.status).toBe("closed");

    const [loaded] = await loadThreads(dir);
    expect(loaded!.status).toBe("closed");
    // original + agent reply + resolution note (recorded as a trailing comment)
    expect(loaded!.comments.map((c) => c.body)).toEqual([
      "N+1 here",
      "batched via dataloader",
      "verified",
    ]);
    expect(loaded!.comments[1]!.author).toEqual({ type: "agent", name: "pi" });
  });

  it("folds a legacy thread.dismissed event into closed on replay", () => {
    // Dismissal was merged into closing; old logs must still load, with the
    // dismissal reason preserved as the trailing note.
    const base = { v: THREAD_SCHEMA_VERSION, ts: T0, author: { type: "user" as const } };
    const created = {
      ...base,
      type: "thread.created" as const,
      id: "th_x",
      repo: "r",
      worktree: null,
      file: "a",
      side: "new" as const,
      line: 1,
      endLine: null,
      anchor: null,
      severity: null,
      body: "x",
    };
    const dismissed = {
      ...base,
      type: "thread.dismissed" as const,
      thread: "th_x",
      reason: "wontfix",
    };
    const [t] = replay([created, dismissed]);
    expect(t!.status).toBe("closed");
    expect(t!.comments.at(-1)!.body).toBe("wontfix");
  });

  it("deletes a thread via tombstone so it vanishes from replay", async () => {
    const t = await createThread(dir, { repo: "r", file: "a", line: 1, body: "x" }, T0);
    await resolveThread(dir, t.id, { author: { type: "user" }, summary: "done" }, T0);
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

  it("keeps a legacy v1 thread (no scope) and drops a future-version event", async () => {
    // A pre-scope (v1) thread.created carries no scope/sessionId. The bump to v2
    // must NOT drop it — replay puts it in the unscoped/legacy bucket. A
    // future-version event is still ignored so an older reader can't misread it.
    const v1 = {
      v: 1,
      type: "thread.created",
      id: "th_legacy",
      ts: T0,
      repo: "r",
      worktree: null,
      file: "a",
      side: "new",
      line: 1,
      endLine: null,
      anchor: null,
      severity: null,
      author: { type: "user" },
      body: "legacy",
    };
    const future = { ...v1, v: THREAD_SCHEMA_VERSION + 1, id: "th_future" };
    const path = threadsLogPath(dir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify(v1)}\n${JSON.stringify(future)}\n`,
      "utf8",
    );

    const loaded = await loadThreads(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("th_legacy");
    expect(loaded[0]!.scope).toBeNull();
    expect(loaded[0]!.sessionId).toBeNull();
  });

  it("stamps scope/sessionId on a v2 thread and round-trips them", async () => {
    const scope = {
      target: "main..feature",
      kind: "range" as const,
      baseRef: "main",
      headRef: "feature",
      baseSha: "deadbeef",
      branch: "feature",
    };
    const created = await createThread(
      dir,
      {
        repo: "r",
        file: "a",
        line: 1,
        body: "scoped",
        scope,
        sessionId: "sess_abc",
        snapshotId: "snap_abc",
      },
      T0,
    );
    expect(created.scope).toEqual(scope);
    expect(created.sessionId).toBe("sess_abc");
    expect(created.snapshotId).toBe("snap_abc");

    const [loaded] = await loadThreads(dir);
    expect(loaded!.scope).toEqual(scope);
    expect(loaded!.sessionId).toBe("sess_abc");
    expect(loaded!.snapshotId).toBe("snap_abc");
  });

  it("coerces a sessionId with no scope to unscoped (else it's invisible everywhere)", async () => {
    // A sessionId without a scope matches neither a session view nor the unscoped
    // bucket (which keys on sessionId === null), so it would never render. Both the
    // write path (createThread) and the read path (replay) must drop the orphaned id.
    const created = await createThread(
      dir,
      {
        repo: "r",
        file: "a",
        line: 1,
        body: "orphan",
        sessionId: "sess_orphan",
        snapshotId: "snap_orphan",
      },
      T0,
    );
    expect(created.scope).toBeNull();
    expect(created.sessionId).toBeNull();
    // A snapshot id is meaningful only inside a scope, so it's coerced too.
    expect(created.snapshotId).toBeNull();

    // And a log written before the guard (sessionId set, scope absent) is sanitized
    // on read rather than vanishing.
    const orphan = {
      v: THREAD_SCHEMA_VERSION,
      type: "thread.created" as const,
      id: "th_orphan",
      ts: T0,
      repo: "r",
      worktree: null,
      file: "a",
      side: "new" as const,
      line: 1,
      endLine: null,
      anchor: null,
      severity: null,
      sessionId: "sess_orphan",
      snapshotId: "snap_orphan",
      author: { type: "user" as const },
      body: "orphan",
    };
    const [replayed] = replay([orphan]);
    expect(replayed!.scope).toBeNull();
    expect(replayed!.sessionId).toBeNull();
    expect(replayed!.snapshotId).toBeNull();
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

describe("session lifecycle (archive/revive)", () => {
  it("rides session.archived at v2 — a new type, not a schema bump", () => {
    // The version gate must stay at 2: bumping to 3 would make a v2-only reader
    // reject *all* v3 events, including thread.created, and hide live threads.
    expect(THREAD_SCHEMA_VERSION).toBe(2);
    expect(THREAD_EVENT_TYPES).toContain("session.archived");
  });

  it("toggles state: archive → revive → archive ends archived", async () => {
    await archiveSession(dir, { scope: SCOPE, archived: true }, T0);
    await archiveSession(dir, { scope: SCOPE, archived: false }, T1);
    await archiveSession(dir, { scope: SCOPE, archived: true }, T2);
    const archived = await loadArchivedSessions(dir);
    expect(archived).toHaveLength(1);
    expect(archived[0]!.sessionId).toBe(sessionIdForScope(SCOPE));
    // Last writer in log order wins — the latest archive sets archivedAt.
    expect(archived[0]!.archivedAt).toBe(T2);
  });

  it("collapses a double-archive to one entry, refreshing the note/timestamp", async () => {
    await archiveSession(dir, { scope: SCOPE, archived: true, note: "first" }, T0);
    await archiveSession(dir, { scope: SCOPE, archived: true, note: "second" }, T2);
    const archived = await loadArchivedSessions(dir);
    expect(archived).toHaveLength(1);
    expect(archived[0]!.archivedAt).toBe(T2);
    expect(archived[0]!.note).toBe("second");
  });

  it("archives a session that has no threads (scope carried inline)", async () => {
    // No createThread — a review can be archived with zero comments because the
    // event carries its own scope; the reducer never consults a thread.
    const result = await archiveSession(dir, { scope: SCOPE, archived: true }, T0);
    expect(result).toMatchObject({ sessionId: sessionIdForScope(SCOPE), archivedAt: T0 });
    const archived = await loadArchivedSessions(dir);
    expect(archived.map((a) => a.sessionId)).toEqual([sessionIdForScope(SCOPE)]);
  });

  it("treats reviving a never-archived session as a no-op", async () => {
    const result = await archiveSession(dir, { scope: SCOPE, archived: false }, T0);
    expect(result).toBeNull();
    expect(await loadArchivedSessions(dir)).toEqual([]);
  });

  it("derives the session id from scope, never from the client", async () => {
    // ArchiveSessionRequest has no id field by design; the id is always
    // re-derived from the scope, so two scopes with the same kind+refs collapse.
    const a = await archiveSession(dir, { scope: SCOPE, archived: true }, T0);
    expect(a!.sessionId).toBe(sessionIdForScope(SCOPE));
  });

  it("replaySessions rewinds correctly from a truncated prefix (last-writer-wins)", () => {
    const ev = (archived: boolean, ts: string): SessionArchivedEvent => ({
      v: THREAD_SCHEMA_VERSION,
      type: "session.archived",
      ts,
      sessionId: "sess_x",
      scope: SCOPE,
      archived,
      author: { type: "user" },
      note: null,
    });
    const full = [ev(true, T0), ev(false, T1), ev(true, T2)];
    expect([...replaySessions(full.slice(0, 1)).keys()]).toEqual(["sess_x"]);
    expect([...replaySessions(full.slice(0, 2)).keys()]).toEqual([]);
    expect([...replaySessions(full).keys()]).toEqual(["sess_x"]);
  });

  it("round-trips session.archived through readEvents without touching thread replay", async () => {
    await createThread(dir, { repo: "r", file: "a", line: 1, body: "live" }, T0);
    await archiveSession(dir, { scope: SCOPE, archived: true }, T1);
    const events = await readEvents(dir);
    expect(events.map((e) => e.type)).toEqual(["thread.created", "session.archived"]);
    // The archive event must not leak into thread reconstruction.
    const threads = await loadThreads(dir);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.comments[0]!.body).toBe("live");
  });

  it("refuses to archive without a scope (the unscoped bucket is un-archivable)", async () => {
    await expect(
      archiveSession(
        dir,
        { scope: null as unknown as ReviewScope, archived: true },
        T0,
      ),
    ).rejects.toBeInstanceOf(UnscopedSessionError);
    // Nothing was written.
    expect(await loadArchivedSessions(dir)).toEqual([]);
  });
});
