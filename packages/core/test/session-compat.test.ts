import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  THREAD_SCHEMA_VERSION,
  type ReviewScope,
  type ThreadCreatedEvent,
} from "@diffect/shared";
import { createServer } from "../src/daemon.js";
import { git } from "../src/git/exec.js";
import {
  legacySessionIdForScope,
  sessionIdForScope,
} from "../src/reviews/scope.js";
import { spaceThreadsLogPath, threadsLogPath } from "../src/store/paths.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "diffect-session-compat-"));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "t@e.com"]);
  await git(dir, ["config", "user.name", "T"]);
  await writeFile(join(dir, "f.txt"), "one\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "base"]);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const directScope: ReviewScope = {
  target: "main..feature",
  kind: "range",
  baseRef: "main",
  headRef: "feature",
  baseSha: "deadbeef",
  branch: "main",
};
const mergeBaseScope: ReviewScope = {
  ...directScope,
  target: "main...feature",
};
const stagedScope: ReviewScope = {
  target: "staged",
  kind: "staged",
  baseRef: "HEAD",
  headRef: "index",
  baseSha: "deadbeef",
  branch: "main",
};

function createdEvent(
  id: string,
  scope: ReviewScope | null,
  worktree: string | null,
  sessionId: string | null,
): ThreadCreatedEvent {
  return {
    v: THREAD_SCHEMA_VERSION,
    type: "thread.created",
    id,
    ts: "2026-07-17T12:00:00.000Z",
    repo: "repo",
    worktree,
    file: "f.txt",
    side: "new",
    line: 1,
    endLine: null,
    anchor: null,
    severity: null,
    scope,
    sessionId,
    author: { type: "user" },
    body: id,
  };
}

describe("session identity compatibility", () => {
  it("projects mixed logs canonically and keeps exact and legacy lookups compatible", async () => {
    const legacy = legacySessionIdForScope(directScope);
    expect(legacy).toBe("sess_4c7006ab6de6d087");
    const storedLegacyAlias = "sess_precanonical_custom";
    const directPrimary = sessionIdForScope(directScope, null);
    const directLinked = sessionIdForScope(directScope, "feature-checkout");
    const mergeBasePrimary = sessionIdForScope(mergeBaseScope, null);
    const stagedPrimary = sessionIdForScope(stagedScope, null);
    const spaceStoredAlias = "sess_space_custom";

    const unscopedV1 = {
      v: 1,
      type: "thread.created",
      id: "th_unscoped_v1",
      ts: "2026-07-17T12:00:00.000Z",
      repo: "repo",
      worktree: null,
      file: "f.txt",
      side: "new",
      line: 1,
      endLine: null,
      anchor: null,
      severity: null,
      author: { type: "user" },
      body: "th_unscoped_v1",
    };
    const events = [
      createdEvent("th_old_primary", directScope, null, storedLegacyAlias),
      createdEvent("th_new_primary", directScope, null, directPrimary),
      createdEvent("th_old_linked", directScope, "feature-checkout", legacy),
      createdEvent("th_old_merge_base", mergeBaseScope, null, legacy),
      unscopedV1,
    ];
    const path = threadsLogPath(dir);
    const spacePath = spaceThreadsLogPath(dir);
    await mkdir(dirname(path), { recursive: true });
    await mkdir(dirname(spacePath), { recursive: true });
    await writeFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    // Deliberately reuse a repo-store thread id in the space store. Stored alias
    // lookup must retain store identity rather than matching the unrelated row.
    await writeFile(
      spacePath,
      `${JSON.stringify(createdEvent("th_old_primary", stagedScope, null, spaceStoredAlias))}\n`,
    );
    const sourceLog = await readFile(path, "utf8");
    const sourceSpaceLog = await readFile(spacePath, "utf8");

    const server = await createServer({ workspacePath: dir });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    type ApiThread = {
      id: string;
      sessionId: string | null;
      spacePath?: string;
    };
    const getBySession = async (session: string) =>
      (await (await fetch(`${base}/threads?session=${encodeURIComponent(session)}`)).json()) as ApiThread[];

    try {
      const all = (await (await fetch(`${base}/threads`)).json()) as ApiThread[];
      expect(all.map((thread) => thread.sessionId)).toEqual([
        stagedPrimary,
        directPrimary,
        directPrimary,
        directLinked,
        mergeBasePrimary,
        null,
      ]);

      expect((await getBySession(directPrimary)).map((thread) => thread.id)).toEqual([
        "th_old_primary",
        "th_new_primary",
      ]);
      expect((await getBySession(directLinked)).map((thread) => thread.id)).toEqual([
        "th_old_linked",
      ]);
      expect((await getBySession(mergeBasePrimary)).map((thread) => thread.id)).toEqual([
        "th_old_merge_base",
      ]);
      expect(
        (await getBySession(storedLegacyAlias)).map((thread) => [
          thread.id,
          thread.spacePath ?? null,
        ]),
      ).toEqual([["th_old_primary", null]]);
      expect(
        (await getBySession(spaceStoredAlias)).map((thread) => [
          thread.id,
          thread.spacePath,
        ]),
      ).toEqual([["th_old_primary", dir]]);

      // The old kind/base/head alias was ambiguous. Preserve that behavior by
      // returning every canonical group it used to collapse, never unscoped v1.
      expect((await getBySession(legacy)).map((thread) => thread.id)).toEqual([
        "th_old_primary",
        "th_new_primary",
        "th_old_linked",
        "th_old_merge_base",
      ]);
      expect(await readFile(path, "utf8")).toBe(sourceLog);
      expect(await readFile(spacePath, "utf8")).toBe(sourceSpaceLog);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
