import { describe, expect, it } from "vitest";
import { openInEditor, PathEscapeError, UnknownEditorError } from "../src/editor.js";

describe("openInEditor guards", () => {
  it("rejects an unsupported editor", async () => {
    await expect(openInEditor("/repo", "a.txt", 1, "nano")).rejects.toBeInstanceOf(
      UnknownEditorError,
    );
  });

  it("rejects a path that escapes the repo root", async () => {
    await expect(
      openInEditor("/repo", "../../etc/passwd", 1, "code"),
    ).rejects.toBeInstanceOf(PathEscapeError);
  });
});
