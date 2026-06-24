import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { git } from "../src/git/exec.js";
import {
  parseGitHubRemote,
  pullRequestForBranch,
} from "../src/git/pull-request.js";

let dir: string;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "diffect-pr-"));
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(dir, { recursive: true, force: true });
});

describe("GitHub PR discovery", () => {
  it("parses common GitHub remotes", () => {
    expect(parseGitHubRemote("git@github.com:acme/widget.git")).toEqual({
      owner: "acme",
      repo: "widget",
    });
    expect(parseGitHubRemote("https://github.com/acme/widget.git")).toEqual({
      owner: "acme",
      repo: "widget",
    });
    expect(parseGitHubRemote("ssh://git@github.com/acme/widget.git")).toEqual({
      owner: "acme",
      repo: "widget",
    });
    expect(parseGitHubRemote("https://example.com/acme/widget.git")).toBeNull();
  });

  it("returns the first open PR for a branch", async () => {
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["remote", "add", "origin", "https://github.com/acme/widget.git"]);
    globalThis.fetch = vi.fn(async () =>
      ({
        ok: true,
        json: async () => [
          {
            number: 12,
            html_url: "https://github.com/acme/widget/pull/12",
            title: "Add widget",
          },
        ],
      }) as Response,
    );

    await expect(pullRequestForBranch(dir, "feature/one")).resolves.toEqual({
      number: 12,
      url: "https://github.com/acme/widget/pull/12",
      title: "Add widget",
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        href: expect.stringContaining("head=acme%3Afeature%2Fone"),
      }),
      expect.any(Object),
    );
  });
});
