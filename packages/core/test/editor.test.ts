import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openInEditor, PathEscapeError, UnknownEditorError } from "../src/editor.js";

describe("openInEditor guards", () => {
  it("rejects an unsupported editor", async () => {
    await expect(openInEditor("/repo", "a.txt", 1, "nano")).rejects.toBeInstanceOf(
      UnknownEditorError,
    );
  });

  it("rejects a path that escapes the repo root via ..", async () => {
    await expect(
      openInEditor("/repo", "../../etc/passwd", 1, "code"),
    ).rejects.toBeInstanceOf(PathEscapeError);
  });

  describe("with a real repo dir", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "diffect-ed-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("rejects an in-repo symlink that resolves outside the repo", async () => {
      // `escape` -> the OS temp root (outside the repo). Opening escape/x must
      // not reach outside the repo.
      await symlink(tmpdir(), join(dir, "escape"));
      await expect(
        openInEditor(dir, "escape/passwd", 1, "code"),
      ).rejects.toBeInstanceOf(PathEscapeError);
    });

    it("allows a normal in-repo file (rejected only by missing editor binary)", async () => {
      await writeFile(join(dir, "a.txt"), "x\n");
      // The path guard must pass; the call then fails only if `code` isn't
      // installed (ENOENT), which is NOT a PathEscapeError.
      await expect(openInEditor(dir, "a.txt", 2, "code")).rejects.not.toBeInstanceOf(
        PathEscapeError,
      );
    });
  });
});
