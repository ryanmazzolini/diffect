import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DiffectSettings } from "@diffect/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/daemon.js";
import { settingsPath } from "../src/store/paths.js";
import {
  defaultSettings,
  parseSettings,
  readSettings,
  replaceSettings,
  SettingsReadError,
  SettingsValidationError,
} from "../src/store/settings.js";

let xdg: string;
let previousXdg: string | undefined;

beforeEach(async () => {
  previousXdg = process.env.XDG_CONFIG_HOME;
  xdg = await mkdtemp(join(tmpdir(), "diffect-settings-"));
  process.env.XDG_CONFIG_HOME = xdg;
});

afterEach(async () => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  await rm(xdg, { recursive: true, force: true });
});

describe("settings store", () => {
  it("returns defaults without creating a missing settings file", async () => {
    expect(await readSettings()).toEqual(defaultSettings());
    await expect(access(settingsPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically replaces and reads a complete valid document", async () => {
    const settings = configuredSettings();
    expect(await replaceSettings(settings)).toEqual(settings);
    expect(await readSettings()).toEqual(settings);
  });

  it("rejects invalid fields without replacing the last good document", async () => {
    const settings = configuredSettings();
    await replaceSettings(settings);
    const invalid: unknown = {
      ...settings,
      workspaceResolution: {
        ...settings.workspaceResolution,
        providers: [
          { id: "duplicate", kind: "herdr", enabled: true, command: "" },
          { id: "duplicate", kind: "cwd", enabled: true, extra: true },
        ],
        bindings: [
          {
            providerId: "missing",
            externalWorkspaceId: "workspace-1",
            diffectWorkspacePath: "/tmp/workspace",
          },
          {
            providerId: "duplicate",
            externalWorkspaceId: "workspace-2",
            diffectWorkspacePath: "relative/path",
          },
        ],
      },
    };

    await expect(replaceSettings(invalid)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "workspaceResolution.providers[0].command" }),
        expect.objectContaining({ path: "workspaceResolution.providers[1].extra" }),
        expect.objectContaining({ path: "workspaceResolution.bindings[0].providerId" }),
        expect.objectContaining({
          path: "workspaceResolution.bindings[1].diffectWorkspacePath",
        }),
      ]),
    });
    expect(await readSettings()).toEqual(settings);
  });

  it("keeps original array indexes in cross-field validation issues", () => {
    const value: unknown = {
      version: 1,
      workspaceResolution: {
        providers: [
          { id: "invalid", kind: "cwd", enabled: "yes" },
          { id: "same", kind: "herdr", enabled: true, command: "herdr" },
          { id: "same", kind: "herdr", enabled: true, command: "herdr" },
        ],
        bindings: [
          {
            providerId: "same",
            externalWorkspaceId: "invalid",
            diffectWorkspacePath: "relative/path",
          },
          {
            providerId: "same",
            externalWorkspaceId: "duplicate",
            diffectWorkspacePath: "/tmp/one",
          },
          {
            providerId: "same",
            externalWorkspaceId: "duplicate",
            diffectWorkspacePath: "/tmp/two",
          },
        ],
      },
    };

    const issues = validationIssues(value);
    expect(issues).toContainEqual({
      path: "workspaceResolution.providers[2].id",
      message: "duplicates provider at index 1",
    });
    expect(issues).toContainEqual({
      path: "workspaceResolution.bindings[2].externalWorkspaceId",
      message: "duplicates binding at index 1",
    });
  });

  it("surfaces malformed JSON and unsupported versions", async () => {
    await mkdir(dirname(settingsPath()), { recursive: true });
    await writeFile(settingsPath(), "not-json", "utf8");
    await expect(readSettings()).rejects.toBeInstanceOf(SettingsReadError);

    await writeFile(
      settingsPath(),
      JSON.stringify({ version: 2, workspaceResolution: { providers: [], bindings: [] } }),
      "utf8",
    );
    await expect(readSettings()).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ path: "version" })]),
    });
  });
});

describe("settings routes", () => {
  it("reads defaults and replaces settings on a loopback daemon", async () => {
    const { server, base } = await startServer("127.0.0.1");
    try {
      const initial = await fetch(`${base}/settings`);
      expect(initial.status).toBe(200);
      expect(await initial.json()).toEqual(defaultSettings());

      const settings = configuredSettings();
      const saved = await fetch(`${base}/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual(settings);
      expect(await readSettings()).toEqual(settings);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns field issues for invalid settings and preserves the previous file", async () => {
    const settings = configuredSettings();
    await replaceSettings(settings);
    const { server, base } = await startServer("127.0.0.1");
    try {
      const response = await fetch(`${base}/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          workspaceResolution: {
            providers: [{ id: "cwd", kind: "cwd", enabled: "yes" }],
            bindings: [],
          },
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "settings are invalid",
        issues: [
          {
            path: "workspaceResolution.providers[0].enabled",
            message: "must be a boolean",
          },
        ],
      });
      expect(await readSettings()).toEqual(settings);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("distinguishes valid JSON null from malformed request bodies", async () => {
    const { server, base } = await startServer("127.0.0.1");
    try {
      const nullResponse = await fetch(`${base}/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "null",
      });
      expect(nullResponse.status).toBe(400);
      expect(await nullResponse.json()).toEqual({
        error: "settings are invalid",
        issues: [{ path: "$", message: "must be an object" }],
      });

      const malformedResponse = await fetch(`${base}/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      expect(malformedResponse.status).toBe(400);
      expect(await malformedResponse.json()).toEqual({
        error: "a valid settings document is required",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects reads and writes on a network-bound daemon", async () => {
    const { server, base } = await startServer("0.0.0.0");
    try {
      expect((await fetch(`${base}/settings`)).status).toBe(403);
      expect(
        (
          await fetch(`${base}/settings`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(defaultSettings()),
          })
        ).status,
      ).toBe(403);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function configuredSettings(): DiffectSettings {
  return {
    version: 1,
    workspaceResolution: {
      providers: [
        {
          id: "herdr-team",
          kind: "herdr",
          enabled: true,
          command: "/opt/homebrew/bin/herdr",
          session: "team",
        },
        {
          id: "cmux-local",
          kind: "cmux",
          enabled: false,
          command: "cmux",
          socketPath: "/tmp/cmux.sock",
        },
        {
          id: "pi-session",
          kind: "pi-session",
          enabled: true,
          sessionsPath: "/tmp/pi-sessions",
        },
        {
          id: "claude-session",
          kind: "claude-session",
          enabled: true,
          projectsPath: "/tmp/claude-projects",
        },
        { id: "cwd", kind: "cwd", enabled: true },
      ],
      bindings: [
        {
          providerId: "herdr-team",
          externalWorkspaceId: "workspace-1",
          diffectWorkspacePath: "/tmp/workspace",
        },
      ],
    },
  };
}

async function startServer(host: string) {
  const server = await createServer({ host });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

function validationIssues(value: unknown) {
  try {
    parseSettings(value);
  } catch (error) {
    if (error instanceof SettingsValidationError) return error.issues;
    throw error;
  }
  throw new Error("expected settings validation to fail");
}
