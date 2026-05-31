import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { createServer } from "../src/daemon.js";
import { addComment, loadThreads, resolveThread } from "../src/reviews/event-log.js";

let dir: string;
const T0 = "2026-05-31T12:00:00.000Z";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "diffect-fix-"));
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

async function start() {
  const server = await createServer({ workspacePath: dir, now: () => T0 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("human → agent fix loop", () => {
  it("human thread, agent reply+resolve offline, resolved after daemon restart", async () => {
    // 1. Human leaves a thread via the browser/API.
    let srv = await start();
    const created = await (
      await fetch(`${srv.base}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: (await (await fetch(`${srv.base}/workspace`)).json()).repos[0].name,
          file: "a.txt",
          side: "new",
          line: 2,
          body: "uppercase?",
        }),
      })
    ).json();
    expect(created.status).toBe("open");

    // 2. Daemon goes down; the agent works through the file store directly.
    await srv.stop();
    await addComment(
      dir,
      created.id,
      { author: { type: "agent", name: "pi" }, body: "fixed in latest commit" },
      T0,
    );
    await resolveThread(
      dir,
      created.id,
      { author: { type: "agent", name: "pi" }, summary: "done" },
      T0,
    );

    // The CLI's view (file store) reflects the resolution with no daemon.
    const offline = await loadThreads(dir);
    expect(offline[0]!.status).toBe("resolved");

    // 3. Restart the daemon — it replays the same log and shows resolved.
    srv = await start();
    const open = await (await fetch(`${srv.base}/threads?status=open`)).json();
    expect(open).toHaveLength(0);
    const resolved = await (await fetch(`${srv.base}/threads?status=resolved`)).json();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.comments.map((c: { body: string }) => c.body)).toEqual([
      "uppercase?",
      "fixed in latest commit",
      "done",
    ]);
    await srv.stop();
  });

  it("daemon endpoints write events: comment, resolve, 404 on unknown", async () => {
    const { base, stop } = await start();
    const repo = (await (await fetch(`${base}/workspace`)).json()).repos[0].name;
    const t = await (
      await fetch(`${base}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, file: "a.txt", side: "new", line: 2, body: "q" }),
      })
    ).json();

    const replied = await (
      await fetch(`${base}/threads/${t.id}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ author: { type: "agent", name: "pi" }, body: "reply" }),
      })
    ).json();
    expect(replied.comments).toHaveLength(2);

    const resolved = await (
      await fetch(`${base}/threads/${t.id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary: "ok" }),
      })
    ).json();
    expect(resolved.status).toBe("resolved");

    const missing = await fetch(`${base}/threads/th_nope/dismiss`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(missing.status).toBe(404);

    await stop();
  });
});
