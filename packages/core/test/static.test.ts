import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { createServer } from "../src/daemon.js";

let parent: string;
let workspace: string;
let webRoot: string;

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "diffect-static-"));
  workspace = join(parent, "ws");
  await mkdir(workspace, { recursive: true });
  await git(workspace, ["init", "-b", "main"]);
  await git(workspace, ["config", "user.email", "t@e.com"]);
  await git(workspace, ["config", "user.name", "T"]);

  webRoot = join(parent, "web");
  await mkdir(join(webRoot, "assets"), { recursive: true });
  await writeFile(join(webRoot, "index.html"), "<title>Diffect</title>");
  await writeFile(join(webRoot, "assets", "app.js"), "console.log(1)");

  // A secret outside webRoot, and a sibling dir sharing the path prefix.
  await writeFile(join(parent, "secret.txt"), "TOP SECRET");
  await mkdir(join(parent, "web-secret"), { recursive: true });
  await writeFile(join(parent, "web-secret", "x.txt"), "SIBLING SECRET");
});
afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

async function start() {
  const server = await createServer({ workspacePath: workspace, webRoot });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("daemon static serving", () => {
  it("serves index.html at / and known assets with correct types", async () => {
    const { base, stop } = await start();
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("<title>Diffect</title>");

    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    await stop();
  });

  it("falls back to index.html for unknown SPA client routes", async () => {
    const { base, stop } = await start();
    const res = await fetch(`${base}/some/client/route`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Diffect</title>");
    await stop();
  });

  it("keeps API routes winning over static", async () => {
    const { base, stop } = await start();
    const ws = await fetch(`${base}/workspace`);
    expect(ws.headers.get("content-type")).toContain("application/json");
    await stop();
  });

  it("blocks traversal (encoded/raw) and sibling-prefix escapes", async () => {
    const { base, stop } = await start();
    for (const attack of [
      "/%2e%2e/secret.txt",
      "/%2e%2e%2fsecret.txt",
      "/..%2f..%2fsecret.txt",
      "/%2e%2e/web-secret/x.txt",
    ]) {
      const res = await fetch(`${base}${attack}`);
      expect(await res.text()).not.toContain("SECRET");
    }
    await stop();
  });

  it("rejects an oversize request body with 413", async () => {
    const { base, stop } = await start();
    const huge = "x".repeat(1024 * 1024 + 10);
    const res = await fetch(`${base}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "ws", body: huge }),
    });
    expect(res.status).toBe(413);
    await stop();
  });
});
