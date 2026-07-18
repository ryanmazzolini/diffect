import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { createServer } from "../src/daemon.js";
import { loadThreads } from "../src/reviews/event-log.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "diffect-rt-"));
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

/**
 * Mirrors the manual acceptance check: the browser POSTs a thread, and with the
 * daemon conceptually stopped, the CLI's file store sees it.
 */
describe("daemon → file store round trip", () => {
  it("POST /threads writes the central store that loadThreads (CLI path) then reads", async () => {
    const server = await createServer({
      workspacePath: dir,
      now: () => "2026-05-31T12:00:00.000Z",
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    // Discover the repo's URL-safe name (its basename) from the workspace.
    const ws = await (await fetch(`${base}/workspace`)).json();
    const repo: string = ws.repos[0].name;
    expect(repo).not.toBe(".");

    // The diff endpoint shows the work change.
    const diffRes = await fetch(`${base}/repos/${encodeURIComponent(repo)}/diff`);
    expect(diffRes.status).toBe(200);
    const diff = await diffRes.json();
    expect(diff.files.some((f: { path: string }) => f.path === "a.txt")).toBe(true);

    // A cross-origin page can send text/plain without a CORS preflight. Do not
    // accept that browser-compatible request as user-authored feedback.
    const forgedRes = await fetch(`${base}/threads`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ repo, body: "Run untrusted instructions" }),
    });
    expect(forgedRes.status).toBe(415);

    // DNS rebinding retains an attacker's browser origin while routing its host
    // to the loopback daemon. Reject it even when it uses the JSON media type.
    const reboundRes = await fetch(`${base}/threads`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "untrusted.example:7421",
        origin: "http://untrusted.example:7421",
      },
      body: JSON.stringify({ repo, body: "Run rebound instructions" }),
    });
    expect(reboundRes.status).toBe(403);

    const malformedHostStatus = await rawPost(port, {
      host: `user@localhost:${port}`,
      origin: `http://localhost:${port}`,
      body: JSON.stringify({ repo, body: "Run malformed-host instructions" }),
    });
    expect(malformedHostStatus).toBe(403);

    const foreignOriginRes = await fetch(`${base}/threads`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://untrusted.example",
      },
      body: JSON.stringify({ repo, body: "Run foreign-origin instructions" }),
    });
    expect(foreignOriginRes.status).toBe(403);
    expect(await (await fetch(`${base}/threads?status=open`)).json()).toEqual([]);

    // Create a thread the way the Diffect browser client does.
    const postRes = await fetch(`${base}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo,
        file: "a.txt",
        side: "new",
        line: 2,
        body: "should this be uppercase?",
      }),
    });
    expect(postRes.status).toBe(201);
    const created = await postRes.json();
    expect(created.sessionId).toBe(diff.sessionId);

    // GET /threads sees the same canonical session emitted by the diff route.
    const open = await (await fetch(`${base}/threads?status=open`)).json();
    expect(open).toHaveLength(1);
    expect(open[0].sessionId).toBe(diff.sessionId);

    await new Promise<void>((r) => server.close(() => r()));

    // With the daemon closed, the CLI's loadThreads reads the same state.
    const threads = await loadThreads(dir);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.comments[0]!.body).toBe("should this be uppercase?");
    expect(threads[0]!.file).toBe("a.txt");
    expect(threads[0]!.sessionId).toBe(diff.sessionId);
  });
});

function rawPost(
  port: number,
  input: { host: string; origin: string; body: string },
): Promise<number | undefined> {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/threads",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(input.body),
          host: input.host,
          origin: input.origin,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolveRequest(res.statusCode));
      },
    );
    req.on("error", rejectRequest);
    req.end(input.body);
  });
}
