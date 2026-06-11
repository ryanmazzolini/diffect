import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { git } from "../src/git/exec.js";
import { formatUrl, parseArgs, resolveWebRoot, runDaemon } from "../src/daemon-start.js";
import { readWorkspaceRegistry } from "../src/store/registry.js";

let parent: string;
let workspace: string;

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "diffect-start-"));
  workspace = join(parent, "ws");
  await git(parent, ["init", "-b", "main", "ws"]);
  await git(workspace, ["config", "user.email", "t@e.com"]);
  await git(workspace, ["config", "user.name", "T"]);
});
afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

describe("parseArgs", () => {
  const noEnv = {} as NodeJS.ProcessEnv;

  it("defaults to cwd, 7421, loopback", () => {
    const args = parseArgs([], noEnv);
    expect(args.workspace).toBe(process.cwd());
    expect(args.port).toBe(7421);
    expect(args.host).toBe("127.0.0.1");
    expect(args.webRoot).toBeUndefined();
  });

  it("reads flags, including --port 0 and --web-root", () => {
    const args = parseArgs(
      ["--workspace", "/ws", "--port", "0", "--host", "::1", "--web-root", "/assets"],
      noEnv,
    );
    expect(args.workspace).toBe(resolve("/ws"));
    expect(args.port).toBe(0);
    expect(args.host).toBe("::1");
    expect(args.webRoot).toBe(resolve("/assets"));
  });

  it("honors env defaults and lets flags override them", () => {
    const env = {
      DIFFECTD_PORT: "9000",
      DIFFECTD_HOST: "0.0.0.0",
      DIFFECTD_WEB_ROOT: "/env-assets",
    } as NodeJS.ProcessEnv;
    expect(parseArgs([], env)).toMatchObject({
      port: 9000,
      host: "0.0.0.0",
      webRoot: resolve("/env-assets"),
    });
    expect(parseArgs(["--port", "0", "--web-root", "/flag"], env)).toMatchObject({
      port: 0,
      webRoot: resolve("/flag"),
    });
  });

  it("clears the boot workspace with --no-workspace", () => {
    expect(parseArgs(["--no-workspace"], noEnv).workspace).toBeNull();
  });

  it("reads --exit-on-stdin-close", () => {
    expect(parseArgs([], noEnv).exitOnStdinClose).toBe(false);
    expect(parseArgs(["--exit-on-stdin-close"], noEnv).exitOnStdinClose).toBe(true);
  });
});

describe("resolveWebRoot", () => {
  it("returns an explicit dir that exists", () => {
    expect(resolveWebRoot(parent)).toBe(parent);
  });

  it("rejects an explicit dir that does not exist", () => {
    expect(() => resolveWebRoot(join(parent, "nope"))).toThrow(/web root not found/);
  });
});

describe("formatUrl", () => {
  it("brackets IPv6 hosts", () => {
    expect(formatUrl("127.0.0.1", 7421)).toBe("http://127.0.0.1:7421");
    expect(formatUrl("::1", 7421)).toBe("http://[::1]:7421");
  });
});

describe("runDaemon", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  function captured() {
    const lines: string[] = [];
    return {
      lines,
      io: {
        stdout: { write: (s: string) => lines.push(...s.split("\n").filter(Boolean)) },
        stderr: { write: () => undefined },
      },
    };
  }

  it("announces the resolved port with DIFFECTD_READY on --port 0", async () => {
    const { lines, io } = captured();
    server = await runDaemon(["--port", "0", "--workspace", workspace], io);
    const ready = lines[0];
    expect(ready).toMatch(/^DIFFECTD_READY http:\/\/127\.0\.0\.1:\d+$/);
    const url = ready.replace("DIFFECTD_READY ", "");
    expect(url).not.toContain(":0");

    const res = await fetch(`${url}/workspace`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("serves an explicit --web-root", async () => {
    const webRoot = join(parent, "web");
    await mkdir(webRoot, { recursive: true });
    await writeFile(join(webRoot, "index.html"), "<title>Diffect</title>");
    const { lines, io } = captured();
    server = await runDaemon(
      ["--port", "0", "--workspace", workspace, "--web-root", webRoot],
      io,
    );
    const url = lines[0].replace("DIFFECTD_READY ", "");
    const res = await fetch(`${url}/`);
    expect(await res.text()).toContain("<title>Diffect</title>");
  });

  it("fails fast on a missing --web-root", async () => {
    const { io } = captured();
    await expect(
      runDaemon(
        ["--port", "0", "--workspace", workspace, "--web-root", join(parent, "nope")],
        io,
      ),
    ).rejects.toThrow(/web root not found/);
  });

  it("exits when stdin closes under --exit-on-stdin-close", async () => {
    const { io } = captured();
    const stdin = new PassThrough();
    let exited = false;
    server = await runDaemon(
      ["--port", "0", "--workspace", workspace, "--exit-on-stdin-close"],
      { ...io, stdin, exit: () => (exited = true) },
    );
    expect(exited).toBe(false);
    stdin.end();
    await vi.waitFor(() => expect(exited).toBe(true));
  });

  it("does not register a workspace with --no-workspace", async () => {
    const { lines, io } = captured();
    server = await runDaemon(["--port", "0", "--no-workspace"], io);
    expect(await readWorkspaceRegistry()).not.toContain(process.cwd());
    const url = lines[0].replace("DIFFECTD_READY ", "");
    const res = await fetch(`${url}/workspace`);
    expect(res.status).toBe(200);
  });
});
