import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { createServer } from "../src/daemon.js";
import { loadArchivedSessions } from "../src/reviews/event-log.js";

let dir: string;
const NOW = "2026-06-15T12:00:00.000Z";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "diffect-sess-archive-"));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "t@e.com"]);
  await git(dir, ["config", "user.name", "T"]);
  await writeFile(join(dir, "a.txt"), "one\ntwo\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "base"]);
  await writeFile(join(dir, "a.txt"), "one\nTWO\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function withServer<T>(
  fn: (base: string, repo: string) => Promise<T>,
): Promise<T> {
  const server = await createServer({ workspacePath: dir, now: () => NOW });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const ws = await (await fetch(`${base}/workspace`)).json();
    return await fn(base, ws.repos[0].name as string);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** The scope the diff route stamps — the same one a real client would echo back. */
async function scopeFromDiff(base: string, repo: string): Promise<unknown> {
  const diff = await (
    await fetch(`${base}/repos/${encodeURIComponent(repo)}/diff`)
  ).json();
  return diff.scope;
}

/** Read SSE frames from a fetch stream until `match` is seen or it times out. */
async function waitForEvent(
  body: ReadableStream<Uint8Array>,
  match: string,
  timeoutMs: number,
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) =>
          setTimeout(() => r({ value: undefined, done: true }), deadline - Date.now()),
        ),
      ]);
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes(match)) return true;
    }
    return false;
  } finally {
    reader.cancel().catch(() => {});
  }
}

describe("session archive route", () => {
  it("archives a review, surfaces it on the workspace summary, then revives it", async () => {
    await withServer(async (base, repo) => {
      const scope = await scopeFromDiff(base, repo);
      const url = `${base}/repos/${encodeURIComponent(repo)}/sessions/archive`;

      // Archive.
      const archiveRes = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, archived: true }),
      });
      expect(archiveRes.status).toBe(200);
      const archivedBody = await archiveRes.json();
      expect(archivedBody.archived).toMatchObject({ archivedAt: NOW });

      // It rides on the workspace summary.
      const ws = await (await fetch(`${base}/workspace`)).json();
      expect(ws.repos[0].archivedSessions).toHaveLength(1);
      const archivedId = ws.repos[0].archivedSessions[0].sessionId;

      // The archived id is the same one the live diff/session derivation stamps,
      // so the client can route it out of the active list reliably.
      expect(ws.repos[0].sessions.map((s: { id: string }) => s.id)).toContain(
        archivedId,
      );

      // Revive.
      const reviveRes = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, archived: false }),
      });
      expect(reviveRes.status).toBe(200);
      expect((await reviveRes.json()).archived).toBeNull();

      const ws2 = await (await fetch(`${base}/workspace`)).json();
      expect(ws2.repos[0].archivedSessions).toEqual([]);
    });
  });

  it("persists the archive to the shared log the CLI path reads", async () => {
    await withServer(async (base, repo) => {
      const scope = await scopeFromDiff(base, repo);
      await fetch(`${base}/repos/${encodeURIComponent(repo)}/sessions/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, archived: true }),
      });
      // Same durable state, read without the daemon.
      const archived = await loadArchivedSessions(dir);
      expect(archived).toHaveLength(1);
      expect(archived[0]!.archivedAt).toBe(NOW);
    });
  });

  it("rejects a request with no scope (400)", async () => {
    await withServer(async (base, repo) => {
      const res = await fetch(
        `${base}/repos/${encodeURIComponent(repo)}/sessions/archive`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ archived: true }),
        },
      );
      expect(res.status).toBe(400);
    });
  });

  it("404s an unknown repo", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/repos/nope/sessions/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: { kind: "work" }, archived: true }),
      });
      expect(res.status).toBe(404);
    });
  });

  it("broadcasts workspace.changed so the client refetches the archived set", async () => {
    // archivedSessions ride on the workspace summary, refetched only on
    // workspace.changed. The archive write fires thread.changed via the fs watch,
    // so the route must announce workspace.changed explicitly (critic fix #2) —
    // without it the archived state wouldn't surface until an unrelated event.
    await withServer(async (base, repo) => {
      const scope = await scopeFromDiff(base, repo);
      const stream = await fetch(`${base}/events`);
      const seen = waitForEvent(stream.body!, "workspace.changed", 5000);
      await fetch(`${base}/repos/${encodeURIComponent(repo)}/sessions/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, archived: true }),
      });
      expect(await seen).toBe(true);
    });
  });
});
