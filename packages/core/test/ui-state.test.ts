import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readUiState, updateUiState } from "../src/store/ui-state.js";
import { uiStatePath } from "../src/store/paths.js";

let xdg: string;

beforeEach(async () => {
  xdg = await mkdtemp(join(tmpdir(), "diffect-ui-state-"));
  process.env.XDG_CONFIG_HOME = xdg;
});

afterEach(async () => {
  await rm(xdg, { recursive: true, force: true });
});

it("merges workspace and review recency updates", async () => {
  await updateUiState({ workspaceRecency: { "/a": 1 } });
  await updateUiState({
    workspaceRecency: { "/b": 2 },
    reviewRecency: {
      "/b": { repo: { worktree: null, target: "main...feature", openedAt: 3 } },
    },
  });
  await updateUiState({
    reviewRecency: {
      "/b": { other: { worktree: "wt", target: "work", openedAt: 4 } },
    },
  });

  expect(await readUiState()).toEqual({
    workspaceRecency: { "/a": 1, "/b": 2 },
    reviewRecency: {
      "/b": {
        repo: { worktree: null, target: "main...feature", openedAt: 3 },
        other: { worktree: "wt", target: "work", openedAt: 4 },
      },
    },
  });
});

it("reads legacy workspace places as review recency", async () => {
  await mkdir(dirname(uiStatePath()), { recursive: true });
  await writeFile(
    uiStatePath(),
    JSON.stringify({
      workspaceRecency: { "/b": 9 },
      workspacePlaces: {
        "/b": {
          selections: { repo: { worktree: null, target: "main...feature" } },
        },
      },
    }),
    "utf8",
  );

  expect(await readUiState()).toEqual({
    workspaceRecency: { "/b": 9 },
    reviewRecency: { "/b": { repo: { worktree: null, target: "main...feature", openedAt: 9 } } },
  });
});

it("serializes concurrent updates", async () => {
  await Promise.all([
    updateUiState({ workspaceRecency: { "/a": 1 } }),
    updateUiState({ workspaceRecency: { "/b": 2 } }),
    updateUiState({ workspaceRecency: { "/c": 3 } }),
  ]);

  expect(await readUiState()).toEqual({
    workspaceRecency: { "/a": 1, "/b": 2, "/c": 3 },
    reviewRecency: {},
  });
});

it("tolerates corrupt ui state", async () => {
  await mkdir(dirname(uiStatePath()), { recursive: true });
  await writeFile(uiStatePath(), "nope", "utf8");
  expect(await readUiState()).toEqual({ workspaceRecency: {}, reviewRecency: {} });
});
