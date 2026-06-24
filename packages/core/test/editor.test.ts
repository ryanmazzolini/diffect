import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the child_process spawn at the system boundary so the editor "launch"
// never shells out to a real editor — running the suite must not pop open the
// developer's VS Code. We assert the path guards and the exact argv instead.
vi.mock("node:child_process", () => ({
  // promisify(execFile) appends the callback as the last argument, so resolve
  // whatever trails the call rather than assuming a fixed arity.
  execFile: vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === "function") {
      (cb as (e: null, o: { stdout: string; stderr: string }) => void)(null, {
        stdout: "",
        stderr: "",
      });
    }
  }),
}));

import { execFile } from "node:child_process";
import {
  openInEditor,
  openWorkspaceInEditor,
  PathEscapeError,
  UnknownEditorError,
} from "../src/editor.js";

describe("openInEditor guards", () => {
  beforeEach(() => vi.mocked(execFile).mockClear());

  it("rejects an unsupported editor (never spawns)", async () => {
    await expect(openInEditor("/repo", "a.txt", 1, "nano")).rejects.toBeInstanceOf(
      UnknownEditorError,
    );
    expect(execFile).not.toHaveBeenCalled();
  });

  it("rejects a path that escapes the repo root via .. (never spawns)", async () => {
    await expect(
      openInEditor("/repo", "../../etc/passwd", 1, "code"),
    ).rejects.toBeInstanceOf(PathEscapeError);
    expect(execFile).not.toHaveBeenCalled();
  });

  describe("with a real repo dir", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "diffect-ed-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("rejects an in-repo symlink that resolves outside the repo (never spawns)", async () => {
      // `escape` -> the OS temp root (outside the repo). Opening escape/x must
      // not reach outside the repo.
      await symlink(tmpdir(), join(dir, "escape"));
      await expect(
        openInEditor(dir, "escape/passwd", 1, "code"),
      ).rejects.toBeInstanceOf(PathEscapeError);
      expect(execFile).not.toHaveBeenCalled();
    });

    it("opens a valid in-repo file via argv (no shell, no real editor launched)", async () => {
      await writeFile(join(dir, "a.txt"), "x\n");
      // The path guard passes, so it resolves; the spawn is stubbed, so the only
      // observable effect is the argv it would have launched.
      await expect(openInEditor(dir, "a.txt", 2, "code")).resolves.toBeUndefined();
      const [cmd, args] = vi.mocked(execFile).mock.calls.at(-1)!;
      expect(cmd).toBe("code");
      expect(args).toEqual(["-g", expect.stringMatching(/a\.txt:2$/)]);
    });

    it("opens a workspace root without a line argument", async () => {
      await expect(openWorkspaceInEditor(dir, "cursor")).resolves.toBeUndefined();
      const [cmd, args] = vi.mocked(execFile).mock.calls.at(-1)!;
      expect(cmd).toBe("cursor");
      expect(args).toEqual([dir]);
    });

    it("opens JetBrains files with --line", async () => {
      await writeFile(join(dir, "a.txt"), "x\n");
      await expect(openInEditor(dir, "a.txt", 3, "webstorm")).resolves.toBeUndefined();
      const [cmd, args] = vi.mocked(execFile).mock.calls.at(-1)!;
      expect(cmd).toBe("webstorm");
      expect(args).toEqual(["--line", "3", expect.stringMatching(/a\.txt$/)]);
    });
  });
});
