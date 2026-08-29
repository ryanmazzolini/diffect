import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANONICAL_LOCAL_ORIGIN,
  ensureDaemon,
  parseManagedEnsureOutput,
  resolveDesktopLauncher,
} from "../../../integrations/pi/diffect.js";

let root: string;
let workspace: string;
let explicit: string;
let previousAppPath: string | undefined;
let previousConfigHome: string | undefined;
const execFileAsync = promisify(execFile);
const packagedLauncher = process.env.DIFFECT_PACKAGED_LAUNCHER;
const packagedSource = process.env.DIFFECT_PACKAGED_SOURCE;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "diffect-pi-launcher-"));
  workspace = join(root, "workspace");
  explicit = join(root, "explicit/diffect-desktop");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(root, "explicit"), { recursive: true });
  await writeFile(explicit, "launcher");
  previousAppPath = process.env.DIFFECT_APP_PATH;
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  delete process.env.DIFFECT_APP_PATH;
  process.env.XDG_CONFIG_HOME = join(root, "config");
});

afterEach(async () => {
  if (previousAppPath === undefined) delete process.env.DIFFECT_APP_PATH;
  else process.env.DIFFECT_APP_PATH = previousAppPath;
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
  await rm(root, { recursive: true, force: true });
});

describe.sequential("Pi installed daemon launcher", () => {
  it("accepts only a ready canonical manager response", () => {
    const valid = JSON.stringify({
      daemon: {
        service: "diffect",
        version: "1.0.0",
        buildId: "release-1",
        instanceId: "instance-1",
        origin: CANONICAL_LOCAL_ORIGIN,
        lifecycle: "ready",
        web: true,
      },
    });
    expect(parseManagedEnsureOutput(valid)).toBe(CANONICAL_LOCAL_ORIGIN);
    expect(() => parseManagedEnsureOutput("not json")).toThrow(/invalid JSON/);
    expect(() =>
      parseManagedEnsureOutput(valid.replace("13433", "7421")),
    ).toThrow(/ready canonical/);
    expect(() =>
      parseManagedEnsureOutput(valid.replace('"web":true', '"web":false')),
    ).toThrow(/ready canonical/);
  });

  it("prefers DIFFECT_APP_PATH, then PATH, then the authority record", async () => {
    const pathLauncher = join(root, "path/diffect-desktop");
    const recordedLauncher = join(root, "recorded/Diffect.AppImage");
    await mkdir(join(root, "path"), { recursive: true });
    await mkdir(join(root, "recorded"), { recursive: true });
    await writeFile(pathLauncher, "path launcher");
    await writeFile(recordedLauncher, "original AppImage");
    await mkdir(join(process.env.XDG_CONFIG_HOME!, "diffect"), { recursive: true });
    await writeFile(
      join(process.env.XDG_CONFIG_HOME!, "diffect/installation.json"),
      JSON.stringify({ launcherPath: recordedLauncher }),
    );

    const pathExec = vi.fn(async () => ({ code: 0, stdout: `${pathLauncher}\n`, stderr: "" }));
    process.env.DIFFECT_APP_PATH = explicit;
    expect((await resolveDesktopLauncher(piWithExec(pathExec), workspace)).command).toBe(
      await realpath(explicit),
    );
    expect(pathExec).not.toHaveBeenCalled();

    delete process.env.DIFFECT_APP_PATH;
    expect((await resolveDesktopLauncher(piWithExec(pathExec), workspace)).command).toBe(
      await realpath(pathLauncher),
    );

    const missingPath = vi.fn(async () => ({ code: 1, stdout: "", stderr: "" }));
    expect((await resolveDesktopLauncher(piWithExec(missingPath), workspace)).command).toBe(
      await realpath(recordedLauncher),
    );
  });

  it("rejects PATH launchers anywhere inside the enclosing repository", async () => {
    const repo = join(root, "repo");
    const nested = join(repo, "src/nested");
    const workspaceLauncher = join(repo, "bin/diffect-desktop");
    const recordedLauncher = join(root, "installed/diffect-desktop");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await mkdir(join(repo, "bin"), { recursive: true });
    await mkdir(join(root, "installed"), { recursive: true });
    await writeFile(workspaceLauncher, "workspace launcher");
    await writeFile(recordedLauncher, "installed launcher");
    await mkdir(join(process.env.XDG_CONFIG_HOME!, "diffect"), { recursive: true });
    await writeFile(
      join(process.env.XDG_CONFIG_HOME!, "diffect/installation.json"),
      JSON.stringify({ launcherPath: recordedLauncher }),
    );
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: `${workspaceLauncher}\n`,
      stderr: "",
    }));

    expect((await resolveDesktopLauncher(piWithExec(exec), nested)).command).toBe(
      await realpath(recordedLauncher),
    );
  });

  it("runs the installed manager synchronously and returns its canonical origin", async () => {
    process.env.DIFFECT_APP_PATH = explicit;
    const exec = vi.fn(async (_command: string, args: string[]) => ({
      code: 0,
      stdout: JSON.stringify({
        daemon: {
          service: "diffect",
          version: "1.0.0",
          buildId: "release-1",
          instanceId: "instance-1",
          origin: CANONICAL_LOCAL_ORIGIN,
          lifecycle: "ready",
          web: true,
        },
      }),
      stderr: "",
    }));

    await expect(ensureDaemon(piWithExec(exec), workspace)).resolves.toBe(
      CANONICAL_LOCAL_ORIGIN,
    );
    expect(exec).toHaveBeenCalledWith(
      await realpath(explicit),
      ["daemon", "ensure", "--json"],
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it.runIf(Boolean(packagedLauncher))(
    "cold-starts and rediscovers the packaged launcher through its authority record",
    async () => {
      const launcher = packagedLauncher!;
      let advertiseOnPath = packagedSource !== "explicit";
      if (packagedSource === "explicit") process.env.DIFFECT_APP_PATH = launcher;
      else delete process.env.DIFFECT_APP_PATH;
      const exec = async (command: string, args: string[]) => {
        if (command === "bash") {
          return advertiseOnPath
            ? { code: 0, stdout: `${launcher}\n`, stderr: "" }
            : { code: 1, stdout: "", stderr: "" };
        }
        const result = await execFileAsync(command, args, {
          env: process.env,
          timeout: 30_000,
        });
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      };
      try {
        const first = await ensureDaemon(piWithExec(exec), workspace);
        delete process.env.DIFFECT_APP_PATH;
        advertiseOnPath = false;
        const second = await ensureDaemon(piWithExec(exec), workspace);
        expect(first).toBe(CANONICAL_LOCAL_ORIGIN);
        expect(second).toBe(first);
      } finally {
        await execFileAsync(launcher, ["daemon", "stop", "--json"], {
          env: {
            ...process.env,
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
            DIFFECT_APP_PATH: launcher,
          },
          timeout: 30_000,
        }).catch(() => undefined);
      }
    },
    60_000,
  );

  it("surfaces manager conflicts without starting a private fallback", async () => {
    process.env.DIFFECT_APP_PATH = explicit;
    const exec = vi.fn(async () => ({
      code: 1,
      stdout: "",
      stderr: "diffectd: 127.0.0.1:13433 is occupied by a process that is not Diffect",
    }));

    await expect(ensureDaemon(piWithExec(exec), workspace)).rejects.toThrow(
      /occupied by a process that is not Diffect/,
    );
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

function piWithExec(exec: unknown): ExtensionAPI {
  return { exec } as unknown as ExtensionAPI;
}
