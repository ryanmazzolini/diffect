import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { workspacesRegistryPath } from "./paths.js";

/**
 * The set of known workspace paths the daemon serves, persisted as a JSON array
 * at `<configDir>/workspaces.json`. This is host config (a list of paths), not
 * review data — review state still lives in the per-repo central store. The CLI
 * is workspace-agnostic, so only the daemon reads this.
 */

/** Read the known workspace paths (absolute). Missing or corrupt file → empty. */
export async function readWorkspaceRegistry(): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(workspacesRegistryPath(), "utf8");
  } catch {
    return []; // not created yet
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string");
  } catch {
    return []; // corrupt registry is recoverable by re-adding; don't crash
  }
}

async function writeRegistry(paths: string[]): Promise<void> {
  const file = workspacesRegistryPath();
  await mkdir(dirname(file), { recursive: true });
  // Write-then-rename so a crash mid-write can't truncate the registry to empty
  // (which readWorkspaceRegistry would silently read as "no workspaces"). rename
  // is atomic on the same filesystem and also shrinks the concurrent-writer race
  // to a near-zero window. Concurrent add/remove is still last-writer-wins, but
  // writes are rare (boot + explicit add/remove) in this single-user daemon.
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(paths, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

/** Add a workspace path (idempotent, stored absolute). Returns the new list. */
export async function addWorkspaceToRegistry(path: string): Promise<string[]> {
  const abs = resolve(path);
  const paths = await readWorkspaceRegistry();
  if (paths.includes(abs)) return paths;
  const next = [...paths, abs];
  await writeRegistry(next);
  return next;
}

/** Remove a workspace path (idempotent). Returns the new list. */
export async function removeWorkspaceFromRegistry(
  path: string,
): Promise<string[]> {
  const abs = resolve(path);
  const paths = await readWorkspaceRegistry();
  const next = paths.filter((p) => p !== abs);
  if (next.length !== paths.length) await writeRegistry(next);
  return next;
}
