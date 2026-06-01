import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { createServer } from "../src/daemon.js";

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
    const seen = waitForEvent(res.body!, "thread.changed", 5000);
    await fetch(`${base}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, file: "a.txt", side: "new", line: 2, body: "q" }),
    });

    expect(await seen).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
  });
});
