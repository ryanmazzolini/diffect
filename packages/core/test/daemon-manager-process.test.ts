import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { managedProcessExists } from "../src/daemon-manager.js";
import { runDaemon } from "../src/daemon-start.js";
import { readManagedDaemon } from "../src/store/managed-daemon.js";

const execFileAsync = promisify(execFile);
const daemonBin = resolve("dist/daemon-bin.js");
let root: string;
let webRoot: string;
let port: number;
let origin: string;
let activeBuild = { version: "1.0.0", id: "release-1", assetId: "" };
let conflictingServer: Server | undefined;

beforeAll(async () => {
  await execFileAsync("pnpm", ["build"], { cwd: resolve("."), timeout: 60_000 });
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "diffect-manager-"));
  webRoot = join(root, "web");
  await mkdir(join(webRoot, "assets"), { recursive: true });
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Managed Diffect</title>");
  await writeFile(join(webRoot, "assets", "app.js"), "console.log('managed')");
  port = await unusedPort();
  origin = `http://127.0.0.1:${port}`;
  activeBuild = {
    version: "1.0.0",
    id: "release-1",
    assetId: await computeWebAssetId(webRoot),
  };
  process.env.XDG_CONFIG_HOME = root;
});

afterEach(async () => {
  if (conflictingServer) {
    await new Promise<void>((done) => conflictingServer!.close(() => done()));
    conflictingServer = undefined;
  }
  process.env.XDG_CONFIG_HOME = root;
  const marker = await readManagedDaemon();
  if (marker?.pid) {
    try {
      process.kill(marker.pid, "SIGTERM");
    } catch {}
    try {
      await vi.waitFor(async () => {
        expect(await portOpen(port)).toBe(false);
      }, { timeout: 1_000 });
    } catch {
      // Test cleanup may interrupt the deliberate held-mutation case. The PID
      // came from this test's isolated lifecycle record, so force only that child.
      try {
        process.kill(marker.pid, "SIGKILL");
      } catch {}
      await vi.waitFor(async () => {
        expect(await portOpen(port)).toBe(false);
      }, { timeout: 3_000 });
    }
  }
  await rm(root, { recursive: true, force: true });
});

describe("persistent daemon manager", () => {
  it("serializes concurrent cold starts and serves one loaded UI/API build", async () => {
    const [first, second] = await Promise.all([manager("ensure"), manager("ensure")]);
    expect(first.daemon.instanceId).toBe(second.daemon.instanceId);
    expect((await manager("attach")).daemon.instanceId).toBe(first.daemon.instanceId);
    expect(first.daemon.origin).toBe(origin);

    const health = await fetchJson(`${origin}/health`);
    expect(health).toMatchObject({
      service: "diffect",
      version: "1.0.0",
      buildId: "release-1",
      lifecycle: "ready",
      web: true,
    });
    expect(await (await fetch(`${origin}/`)).text()).toContain("Managed Diffect");
    expect((await fetch(`${origin}/workspace`)).status).toBe(200);
    expect((await fetch(`${origin}/daemon/stop`, {
      method: "POST",
      headers: { "x-diffect-daemon-token": "wrong" },
    })).status).toBe(403);
    expect(await fetchJson(`${origin}/health`)).toMatchObject({ lifecycle: "ready" });

    // Production assets are held by the daemon, not read from a replaceable app bundle.
    await rm(webRoot, { recursive: true, force: true });
    expect(await (await fetch(`${origin}/`)).text()).toContain("Managed Diffect");
    expect(await (await fetch(`${origin}/assets/app.js`)).text()).toContain("managed");
  });

  it("refuses implicit build replacement, then gracefully restarts the authoritative build", async () => {
    const first = await manager("ensure");
    const oldPid = (await readManagedDaemon())!.pid;
    await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Release 2</title>");
    activeBuild = {
      version: "1.1.0",
      id: "release-2",
      assetId: await computeWebAssetId(webRoot),
    };
    await expect(manager("ensure")).rejects.toThrow(/quit desktop clients and restart/);

    const status = await manager("status");
    expect(status).toMatchObject({
      state: "running",
      installation: { version: "1.1.0", buildId: "release-2" },
      daemon: { version: "1.0.0", buildId: "release-1" },
    });

    const restarted = await manager("restart");
    expect(restarted.daemon.instanceId).not.toBe(first.daemon.instanceId);
    expect(restarted.daemon).toMatchObject({ version: "1.1.0", buildId: "release-2" });
    expect(await (await fetch(`${origin}/`)).text()).toContain("Release 2");
    expect(managedProcessExists(oldPid)).toBe(false);

    activeBuild = {
      version: "1.0.0",
      id: "release-1",
      assetId: await computeWebAssetId(webRoot),
    };
    await expect(manager("ensure")).rejects.toThrow(/cannot replace it without confirmed rollback/);
  });

  it("closes SSE and waits for an active mutation before replacement", async () => {
    const first = await manager("ensure");
    const oldPid = (await readManagedDaemon())!.pid;
    const events = await fetch(`${origin}/events`);
    const reader = events.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("connected");
    const streamClosed = waitForStreamEnd(reader);

    const mutation = await heldUiStateMutation();
    await vi.waitFor(async () => {
      expect(await fetchJson(`${origin}/health`)).toMatchObject({ activeMutations: 1 });
    });
    const restarting = manager("restart");
    await vi.waitFor(async () => {
      expect(await fetchJson(`${origin}/health`)).toMatchObject({ lifecycle: "draining" });
    });
    await expect(streamClosed).resolves.toBeUndefined();

    // The restart cannot complete until the request body and mutation finish.
    let completed = false;
    void restarting.then(() => (completed = true));
    await new Promise((done) => setTimeout(done, 100));
    expect(completed).toBe(false);
    mutation.finish();

    const restarted = await restarting;
    expect(restarted.daemon.instanceId).not.toBe(first.daemon.instanceId);
    expect(await mutation.response).toMatch(/^HTTP\/1\.1 200/);
    expect(await fetchJson(`${origin}/ui-state`)).toMatchObject({
      workspaceRecency: { "/held-during-restart": 123 },
    });
    expect(managedProcessExists(oldPid)).toBe(false);
  }, 30_000);

  it("keeps unmanaged diagnostic markers separate from lifecycle credentials", async () => {
    const managed = await manager("ensure");
    const unmanaged = await runDaemon(["--port", "0", "--no-workspace"], {
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    });
    try {
      expect((await manager("ensure")).daemon.instanceId).toBe(managed.daemon.instanceId);
    } finally {
      await new Promise<void>((done) => unmanaged.close(() => done()));
    }
  });

  it("requires proof of the private lifecycle credential before reuse", async () => {
    await manager("ensure");
    const capturedHealth = await fetchJson(`${origin}/health`);
    const oldPid = (await readManagedDaemon())!.pid;
    process.kill(oldPid, "SIGKILL");
    await vi.waitFor(async () => expect(await portOpen(port)).toBe(false));

    let receivedStopToken = false;
    conflictingServer = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(capturedHealth));
      } else if (req.url === "/daemon/prove") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ proof: "0".repeat(64) }));
      } else {
        receivedStopToken ||= Boolean(req.headers["x-diffect-daemon-token"]);
        res.writeHead(202, { "content-type": "application/json" });
        res.end("{}");
      }
    });
    await new Promise<void>((done) => conflictingServer!.listen(port, "127.0.0.1", done));

    await expect(manager("ensure")).rejects.toThrow(/failed lifecycle proof/);
    expect(receivedStopToken).toBe(false);
  });

  it("reports a non-Diffect listener instead of choosing another port", async () => {
    conflictingServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("not Diffect");
    });
    await new Promise<void>((done) => conflictingServer!.listen(port, "127.0.0.1", done));

    await expect(manager("ensure")).rejects.toThrow(/occupied by a process/);
  });
});

async function manager(command: string): Promise<any> {
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: root,
    DIFFECT_RELEASE_VERSION: activeBuild.version,
    DIFFECT_BUILD_ID: activeBuild.id,
    DIFFECT_WEB_ASSET_ID: activeBuild.assetId,
    DIFFECT_INSTALL_SOURCE: "explicit",
    DIFFECT_LAUNCHER_PATH: daemonBin,
    DIFFECT_WEB_ROOT: webRoot,
    NODE_ENV: "test",
    DIFFECT_TEST_MANAGED_PORT: String(port),
  };
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [daemonBin, command],
      { cwd: resolve("."), env, timeout: 20_000, maxBuffer: 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message);
  }
}

async function computeWebAssetId(root: string): Promise<string> {
  const files: Array<[string, string]> = [];
  async function visit(directory: string, prefix = ""): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, relative);
      else if (entry.isFile()) files.push([relative, path]);
    }
  }
  await visit(root);
  files.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const hash = createHash("sha256");
  for (const [relative, path] of files) {
    hash.update(relative, "utf8");
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function heldUiStateMutation(): Promise<{
  finish(): void;
  response: Promise<string>;
}> {
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((done, reject) => {
    socket.once("connect", done);
    socket.once("error", reject);
  });
  let received = "";
  socket.on("data", (chunk) => {
    received += chunk.toString();
  });
  const response = new Promise<string>((done) => socket.once("close", () => done(received)));
  socket.resume();
  const body = JSON.stringify({ workspaceRecency: { "/held-during-restart": 123 } });
  socket.write(
    "POST /ui-state HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${port}\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n\r\n" +
      body.slice(0, 1),
  );
  return {
    finish() {
      socket.write(body.slice(1));
    },
    response,
  };
}

async function waitForStreamEnd(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  while (!(await reader.read()).done) {}
}

async function fetchJson(url: string): Promise<any> {
  return (await fetch(url)).json();
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

function portOpen(target: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(target, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}
