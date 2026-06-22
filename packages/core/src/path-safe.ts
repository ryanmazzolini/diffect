import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * Resolve a path as far as it exists, following symlinks, without throwing on a
 * not-yet-existing tail (resolves the existing prefix, appends the rest). Lets a
 * containment check survive paths whose final segments don't exist yet.
 */
export function realpathSafe(p: string): string {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return tail.length ? resolve(realpathSync(head), ...tail) : realpathSync(head);
    } catch {
      const parent = dirname(head);
      if (parent === head) return p; // reached the root without resolving
      tail.unshift(head.slice(parent.length + 1));
      head = parent;
    }
  }
}

/**
 * Resolve `file` under `repoRoot` and confirm it stays inside the repo (after
 * following symlinks). Returns the safe absolute path, or null if it escapes via
 * `..`, an absolute path, or an out-of-tree symlink — the guard for any
 * user-supplied repo-relative path that reaches the filesystem.
 */
export function containedPath(repoRoot: string, file: string): string | null {
  const root = realpathSafe(resolve(repoRoot));
  const abs = realpathSafe(resolve(root, file));
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}
