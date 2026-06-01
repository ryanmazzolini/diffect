import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Root config directory for Diffect, XDG-aware: `$XDG_CONFIG_HOME/diffect` when
 * set, else `~/.config/diffect`. This holds host-local config plus the central
 * review store — review data is no longer committed beside the code (see
 * ./migrate.ts for how legacy in-tree stores move here).
 */
export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : join(homedir(), ".config");
  return join(base, "diffect");
}

/**
 * Stable identifier for a repo's central store: the sha256 of its absolute
 * working-tree root. Keyed by repo (not workspace) so the same repo resolves to
 * one store whether reached directly or via a multi-repo workspace.
 */
export function hashRepoPath(repoRoot: string): string {
  return createHash("sha256").update(resolve(repoRoot), "utf8").digest("hex");
}

/** Per-repo central store directory: `<configDir>/workspaces/<hash>/`. */
export function repoStoreDir(repoRoot: string): string {
  return join(configDir(), "workspaces", hashRepoPath(repoRoot));
}

/** The append-only thread event log for a repo. */
export function threadsLogPath(repoRoot: string): string {
  return join(repoStoreDir(repoRoot), "threads.jsonl");
}

/** Persisted list of known workspace paths (consumed by the workspace registry). */
export function workspacesRegistryPath(): string {
  return join(configDir(), "workspaces.json");
}
