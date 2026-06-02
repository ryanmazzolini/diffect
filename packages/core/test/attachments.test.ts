import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { createServer } from "../src/daemon.js";

let dir: string;
let base: string;
let close: () => Promise<void>;

async function start(opts: { host?: string } = {}) {
  const server = await createServer({ workspacePath: dir, host: opts.host });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((r) => server.close(() => r()));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "diffect-att-"));
  await git(dir, ["init", "-b", "main"]);
});
afterEach(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("attachments", () => {
  it("stores an upload and serves it back content-addressed", async () => {
    await start();
    const up = await fetch(`${base}/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png", "x-filename": "shot.png" },
      body: PNG,
    });
    expect(up.status).toBe(200);
    const { url, name } = await up.json();
    expect(url).toMatch(/^\/attachments\/[a-f0-9]{64}\.png$/);
    expect(name).toBe("shot.png");

    const got = await fetch(`${base}${url}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await got.arrayBuffer())).toEqual(PNG);
  });

  it("dedupes identical content to the same id", async () => {
    await start();
    const post = () =>
      fetch(`${base}/attachments`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: PNG,
      }).then((r) => r.json());
    expect((await post()).url).toBe((await post()).url);
  });

  it("rejects an empty upload and a traversal-shaped id", async () => {
    await start();
    expect(
      (await fetch(`${base}/attachments`, { method: "POST", body: "" })).status,
    ).toBe(400);
    // Anything but <sha>.<ext> is refused before touching the filesystem.
    expect((await fetch(`${base}/attachments/not-a-valid-id`)).status).toBe(400);
    expect(
      (await fetch(`${base}/attachments/${encodeURIComponent("../../etc/passwd")}`))
        .status,
    ).toBe(400);
  });

  it("refuses uploads when the daemon is not loopback-bound", async () => {
    await start({ host: "0.0.0.0" });
    const res = await fetch(`${base}/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: PNG,
    });
    expect(res.status).toBe(403);
  });
});
