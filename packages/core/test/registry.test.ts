import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addWorkspaceToRegistry,
  readWorkspaceRegistry,
  removeWorkspaceFromRegistry,
} from "../src/store/registry.js";
import { workspacesRegistryPath } from "../src/store/paths.js";

let xdg: string;

// The registry is a single fixed file under the config dir, so give every test
// its own XDG_CONFIG_HOME (overriding the per-file default) for isolation.
beforeEach(async () => {
  xdg = await mkdtemp(join(tmpdir(), "diffect-reg-"));
  process.env.XDG_CONFIG_HOME = xdg;
});
afterEach(async () => {
  await rm(xdg, { recursive: true, force: true });
});

describe("workspace registry", () => {
  it("returns [] when no registry exists yet", async () => {
    expect(await readWorkspaceRegistry()).toEqual([]);
  });

  it("adds paths idempotently, stored absolute", async () => {
    await addWorkspaceToRegistry("/tmp/a");
    const list = await addWorkspaceToRegistry("/tmp/a"); // duplicate
    expect(list).toEqual([resolve("/tmp/a")]);
    await addWorkspaceToRegistry("/tmp/b");
    expect(await readWorkspaceRegistry()).toEqual([
      resolve("/tmp/a"),
      resolve("/tmp/b"),
    ]);
  });

  it("removes a path idempotently", async () => {
    await addWorkspaceToRegistry("/tmp/a");
    await addWorkspaceToRegistry("/tmp/b");
    const after = await removeWorkspaceFromRegistry("/tmp/a");
    expect(after).toEqual([resolve("/tmp/b")]);
    // removing an absent path is a no-op
    expect(await removeWorkspaceFromRegistry("/tmp/missing")).toEqual([
      resolve("/tmp/b"),
    ]);
  });

  it("tolerates a corrupt registry file (returns [])", async () => {
    await addWorkspaceToRegistry("/tmp/a");
    await writeFile(workspacesRegistryPath(), "{ not json", "utf8");
    expect(await readWorkspaceRegistry()).toEqual([]);
  });

  it("ignores a non-array JSON document", async () => {
    await mkdir(dirname(workspacesRegistryPath()), { recursive: true });
    await writeFile(workspacesRegistryPath(), '{"a":1}', "utf8");
    expect(await readWorkspaceRegistry()).toEqual([]);
  });

  it("filters non-string entries from the array", async () => {
    await mkdir(dirname(workspacesRegistryPath()), { recursive: true });
    await writeFile(workspacesRegistryPath(), '["/tmp/a", 42, null]', "utf8");
    expect(await readWorkspaceRegistry()).toEqual(["/tmp/a"]);
  });
});
