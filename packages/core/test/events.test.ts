import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { DaemonEventPayload, FeedbackAddedPayload, Thread } from "@diffect/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { createServer } from "../src/daemon.js";
import { addComment, createThread } from "../src/reviews/event-log.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "diffect-evt-"));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "t@e.com"]);
  await git(dir, ["config", "user.name", "T"]);
  await writeFile(join(dir, "a.txt"), "one\ntwo\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "base"]);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Read and parse matching SSE frames until `count` arrive or the stream times out. */
async function waitForEvents<T extends DaemonEventPayload = DaemonEventPayload>(
  body: ReadableStream<Uint8Array>,
  eventName: string,
  count: number,
  timeoutMs: number,
): Promise<T[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const found: T[] = [];
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline && found.length < count) {
      let timeout: NodeJS.Timeout | undefined;
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolveTimeout) => {
          timeout = setTimeout(
            () => resolveTimeout({ value: undefined, done: true }),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let boundary = buf.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buf.slice(0, boundary);
        buf = buf.slice(boundary + 2);
        const lines = frame.split("\n");
        const type = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (type === eventName && data) {
          found.push(JSON.parse(data) as T);
        }
        boundary = buf.indexOf("\n\n");
      }
    }
    return found;
  } finally {
    reader.cancel().catch(() => {});
  }
}

describe("daemon SSE /events", () => {
  it("emits thread.changed when the central store is written", async () => {
    const server = await createServer({ workspacePath: dir });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const res = await fetch(`${base}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Trigger a thread write via the API after subscribing.
    const repo = (await (await fetch(`${base}/workspace`)).json()).repos[0].name;
    const seen = waitForEvents(res.body!, "thread.changed", 1, 5000);
    await fetch(`${base}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, file: "a.txt", side: "new", line: 2, body: "q" }),
    });

    expect(await seen).toHaveLength(1);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("emits feedback.added for a newly created thread", async () => {
    const server = await createServer({ workspacePath: dir });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const repo = (await (await fetch(`${base}/workspace`)).json()).repos[0].name;

    const res = await fetch(`${base}/events`);
    const seen = waitForEvents<FeedbackAddedPayload>(
      res.body!,
      "feedback.added",
      1,
      5000,
    );
    const created = (await (
      await fetch(`${base}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo,
          file: "a.txt",
          side: "new",
          line: 2,
          author: { type: "user", name: "Reviewer" },
          body: "Please change this",
        }),
      })
    ).json()) as Thread;

    const [payload] = await seen;
    expect(payload).toEqual({
      eventId: `thread.created:${created.id}`,
      workspacePaths: [dir],
      threadId: created.id,
      source: "thread.created",
      author: { type: "user", name: "Reviewer" },
    });
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("replays feedback missed during a short SSE reconnect gap", async () => {
    const server = await createServer({ workspacePath: dir });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const repo = (await (await fetch(`${base}/workspace`)).json()).repos[0].name;
    const create = async (body: string) =>
      (await (
        await fetch(`${base}/threads`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repo, targetLevel: "repo", body }),
        })
      ).json()) as Thread;

    const firstResponse = await fetch(`${base}/events`);
    const firstSeen = waitForEvents<FeedbackAddedPayload>(
      firstResponse.body!,
      "feedback.added",
      1,
      5000,
    );
    const first = await create("First");
    const [firstEvent] = await firstSeen;
    expect(firstEvent.threadId).toBe(first.id);

    const second = await create("Second");
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    const resumedResponse = await fetch(`${base}/events`, {
      headers: { "last-event-id": firstEvent.eventId },
    });
    const [replayed] = await waitForEvents<FeedbackAddedPayload>(
      resumedResponse.body!,
      "feedback.added",
      1,
      5000,
    );

    expect(replayed.threadId).toBe(second.id);
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  it("emits only newly appended feedback after seeding an existing thread", async () => {
    const existing = await createThread(
      dir,
      {
        repo: null,
        targetLevel: "repo",
        author: { type: "user", name: "Reviewer" },
        body: "Existing feedback",
      },
      "2026-01-01T00:00:00.000Z",
    );
    const server = await createServer({ workspacePath: dir });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const res = await fetch(`${base}/events`);
    const seen = waitForEvents<FeedbackAddedPayload>(
      res.body!,
      "feedback.added",
      1,
      5000,
    );
    const updated = await addComment(
      dir,
      existing.id,
      {
        author: { type: "agent", name: "reviewer/test" },
        body: "New reply",
      },
      "2026-01-01T00:01:00.000Z",
    );
    const comment = updated.comments.at(-1)!;

    expect(await seen).toEqual([
      {
        eventId: `comment.added:${comment.id}`,
        workspacePaths: [dir],
        threadId: existing.id,
        source: "comment.added",
        author: { type: "agent", name: "reviewer/test" },
      },
    ]);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("reports every registered workspace that contains a shared repo store", async () => {
    const space = await mkdtemp(join(tmpdir(), "diffect-evt-space-"));
    const repoRoot = join(space, "repo");
    await mkdir(repoRoot);
    await git(repoRoot, ["init", "-b", "main"]);
    await git(repoRoot, ["config", "user.email", "t@e.com"]);
    await git(repoRoot, ["config", "user.name", "T"]);
    await writeFile(join(repoRoot, "a.txt"), "one\n");
    await git(repoRoot, ["add", "."]);
    await git(repoRoot, ["commit", "-m", "base"]);

    const server = await createServer({ workspacePath: repoRoot });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    await fetch(`${base}/workspaces?summary=0`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: space }),
    });

    const response = await fetch(`${base}/events`);
    const seen = waitForEvents<FeedbackAddedPayload>(
      response.body!,
      "feedback.added",
      1,
      5000,
    );
    const created = await createThread(
      repoRoot,
      { repo: "repo", targetLevel: "repo", body: "Shared feedback" },
      "2026-01-01T00:00:00.000Z",
    );
    const [payload] = await seen;

    expect(payload.threadId).toBe(created.id);
    expect(new Set(payload.workspacePaths)).toEqual(new Set([space, repoRoot]));
    await fetch(`${base}/workspaces?summary=0`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: space }),
    });
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(space, { recursive: true, force: true });
  });

  it("does not collapse distinct feedback added in the same debounce window", async () => {
    const server = await createServer({ workspacePath: dir });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const repo = (await (await fetch(`${base}/workspace`)).json()).repos[0].name;

    const res = await fetch(`${base}/events`);
    const seen = waitForEvents(res.body!, "feedback.added", 2, 5000);
    const create = (body: string) =>
      fetch(`${base}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, targetLevel: "repo", body }),
      });
    await create("First");
    await create("Second");

    const payloads = await seen;
    expect(payloads).toHaveLength(2);
    expect(new Set(payloads.map((payload) => payload.eventId)).size).toBe(2);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("emits diff.changed with the changed file path", async () => {
    const server = await createServer({ workspacePath: dir });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const res = await fetch(`${base}/events`);
    const seen = waitForEvents(res.body!, "diff.changed", 1, 5000);
    await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n");

    expect(await seen).toEqual([expect.objectContaining({ path: "a.txt" })]);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("emits workspace.changed when the checked-out branch changes", async () => {
    await git(dir, ["branch", "feature"]);
    const server = await createServer({ workspacePath: dir });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const res = await fetch(`${base}/events`);
    const seen = waitForEvents(res.body!, "workspace.changed", 1, 5000);
    await git(dir, ["switch", "feature"]);

    expect(await seen).toHaveLength(1);
    await new Promise<void>((r) => server.close(() => r()));
  });
});
