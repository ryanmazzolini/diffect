import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LockOptions } from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsPath } from "../src/store/paths.js";

const lockMock = vi.hoisted(() => vi.fn());

vi.mock("proper-lockfile", () => ({ lock: lockMock }));

import {
  defaultSettings,
  readSettings,
  replaceSettings,
  SettingsBusyError,
  SettingsReadError,
} from "../src/store/settings.js";

let xdg: string;
let previousXdg: string | undefined;

beforeEach(async () => {
  lockMock.mockReset();
  previousXdg = process.env.XDG_CONFIG_HOME;
  xdg = await mkdtemp(join(tmpdir(), "diffect-settings-lock-"));
  process.env.XDG_CONFIG_HOME = xdg;
});

afterEach(async () => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  await rm(xdg, { recursive: true, force: true });
});

describe("settings lock failures", () => {
  it("reports a post-commit release failure without losing the saved document", async () => {
    lockMock.mockResolvedValue(async () => {
      throw new Error("release failed");
    });
    const settings = defaultSettings("/home/test");

    await expect(replaceSettings(settings)).rejects.toThrow(
      "settings were saved but the lock could not be released",
    );
    expect(await readSettings()).toEqual(settings);
  });

  it("preserves the operation error when releasing also fails", async () => {
    lockMock.mockResolvedValue(async () => {
      throw new Error("release failed");
    });
    await mkdir(dirname(settingsPath()), { recursive: true });
    await writeFile(settingsPath(), "not-json", "utf8");

    await expect(
      replaceSettings(defaultSettings("/home/test"), { ifRevision: "stale" }),
    ).rejects.toBeInstanceOf(SettingsReadError);
  });

  it("contains compromise callbacks and reports a retryable settings error", async () => {
    lockMock.mockImplementation(async (_file: string, options: LockOptions) => {
      options.onCompromised?.(new Error("lock compromised"));
      return async () => {
        throw Object.assign(new Error("already released"), { code: "ERELEASED" });
      };
    });
    const settings = defaultSettings("/home/test");

    await expect(replaceSettings(settings)).rejects.toBeInstanceOf(SettingsBusyError);
    expect(await readSettings()).toEqual(settings);
  });
});
