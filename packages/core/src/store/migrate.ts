import { constants, existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { threadsLogPath } from "./paths.js";

/**
 * Lazily migrate a legacy in-tree review log into the central store. Earlier
 * Diffect wrote `<repoRoot>/.reviews/threads.jsonl`; the canonical store is now
 * `<configDir>/workspaces/<hash>/threads.jsonl`. This copies the legacy log on
 * first central access. It is:
 *   - idempotent: skips when the central log already exists,
 *   - append-only-safe: copies, never rewrites or deletes the legacy file (it
 *     remains as a backup; safe to remove by hand after upgrading),
 *   - race-tolerant: an EEXIST from a concurrent first write counts as success.
 *
 * Multi-repo legacy workspaces (one `.reviews` log shared by several repos) are
 * not auto-split — only single-repo legacy stores migrate cleanly.
 */
export async function migrateLegacyStore(repoRoot: string): Promise<void> {
  const central = threadsLogPath(repoRoot);
  if (existsSync(central)) return; // already migrated (or already in use)
  const legacy = join(resolve(repoRoot), ".reviews", "threads.jsonl");
  if (!existsSync(legacy)) return;
  await mkdir(dirname(central), { recursive: true });
  try {
    await copyFile(legacy, central, constants.COPYFILE_EXCL);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}
