import { describe, expect, it, vi } from "vitest";
import { openExternalUrl, UnsupportedUrlError } from "../src/open-url.js";

describe("openExternalUrl", () => {
  it("opens http urls without a shell", async () => {
    const run = vi.fn(async () => {});
    await openExternalUrl("https://github.com/ryanmazzolini/diffect/pull/11", run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![1]).toContain(
      "https://github.com/ryanmazzolini/diffect/pull/11",
    );
  });

  it("rejects non-web urls", async () => {
    const run = vi.fn(async () => {});
    await expect(openExternalUrl("file:///etc/passwd", run)).rejects.toBeInstanceOf(
      UnsupportedUrlError,
    );
    expect(run).not.toHaveBeenCalled();
  });
});
