import { lstat, readFile, readlink, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { FileContent, ReviewTarget } from "@diffect/shared";
import { containedPath } from "../path-safe.js";
import { resolveWorkBase } from "./diff.js";
import { git, gitTry } from "./exec.js";

/** Where one side of a target's diff reads its full file content from. */
type ContentSource =
  | { kind: "rev"; rev: string } // a resolved commit blob: `git show <sha>:<path>`
  | { kind: "index" } // the staged blob: `git show :<path>`
  | { kind: "worktree" } // the file on disk
  | { kind: "empty" }; // legitimately absent (added → old, deleted → new)

/**
 * Resolve the two sides a target diffs, mirroring computeTargetDiff:
 *   work     base(merge-base) → worktree
 *   staged   HEAD             → index
 *   unstaged index            → worktree
 *   ref      <ref>            → worktree
 *   range    a (or merge-base for three-dot) → b
 */
async function targetSides(
  repoRoot: string,
  target: ReviewTarget,
): Promise<{ old: ContentSource; new: ContentSource }> {
  switch (target.kind) {
    case "work": {
      const base = await resolveWorkBase(repoRoot);
      return {
        old: base ? { kind: "rev", rev: base } : { kind: "empty" },
        new: { kind: "worktree" },
      };
    }
    case "staged":
      return { old: { kind: "rev", rev: "HEAD" }, new: { kind: "index" } };
    case "unstaged":
      return { old: { kind: "index" }, new: { kind: "worktree" } };
    case "ref":
      return { old: await revSource(repoRoot, target.from!), new: { kind: "worktree" } };
    case "range": {
      if (target.threeDot) {
        const mb = await gitTry(repoRoot, [
          "merge-base",
          "--end-of-options",
          target.from!,
          target.to!,
        ]);
        return {
          old: mb ? { kind: "rev", rev: mb } : { kind: "empty" },
          new: await revSource(repoRoot, target.to!),
        };
      }
      return {
        old: await revSource(repoRoot, target.from!),
        new: await revSource(repoRoot, target.to!),
      };
    }
  }
}

/**
 * Resolve a possibly user-supplied ref to a commit SHA up front, so the later
 * `git show <sha>:<path>` can never be parsed as a flag (a ref like `--output=…`
 * is an argument-injection vector). Falls back to an empty side if it won't resolve.
 */
async function revSource(repoRoot: string, ref: string): Promise<ContentSource> {
  const sha = await gitTry(repoRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  return sha ? { kind: "rev", rev: sha } : { kind: "empty" };
}

async function readSource(
  repoRoot: string,
  source: ContentSource,
  path: string,
): Promise<string | null> {
  switch (source.kind) {
    case "empty":
      return "";
    case "worktree": {
      // `path` is client-supplied; confine the read to the repo.
      const abs = containedPath(repoRoot, path);
      if (!abs) return null;
      // git stores a symlink's *target path string* as its blob, not the target
      // file's bytes — so mirror that here, else the worktree side disagrees with
      // the blob the diff was computed from. containedPath proved the path
      // resolves in-repo, so lstat-ing the unresolved path is safe.
      const link = resolve(repoRoot, path);
      try {
        if ((await lstat(link)).isSymbolicLink()) return await readlink(link);
      } catch {
        // not a symlink / vanished — fall through to a normal file read
      }
      try {
        const content = await readFile(abs, "utf8");
        return content.includes("\0") ? null : content; // skip binary
      } catch (e) {
        // A missing worktree file is a legitimately-empty side (the new side of
        // a deletion), not an error — distinct from an unreadable one.
        return (e as NodeJS.ErrnoException).code === "ENOENT" ? "" : null;
      }
    }
    // The blob specs below start with a 40-hex SHA or ":", never "-". git itself
    // rejects "..": and absolute specs, but assert the containment invariant up
    // front (defense in depth) so blob reads match the worktree side's guard.
    case "index":
      return blobInTree(path) ? showBlob(repoRoot, `:${path}`) : null;
    case "rev":
      return blobInTree(path) ? showBlob(repoRoot, `${source.rev}:${path}`) : null;
  }
}

/** A repo-relative blob path must not be absolute or contain a ".." segment. */
function blobInTree(path: string): boolean {
  return !isAbsolute(path) && !path.split("/").includes("..");
}

async function showBlob(repoRoot: string, spec: string): Promise<string | null> {
  try {
    const { stdout } = await git(repoRoot, ["show", spec]);
    return stdout.includes("\0") ? null : stdout; // skip binary
  } catch {
    // The rev was already verified, so a failure here means the path doesn't
    // exist on that side — i.e. the file was added (no old blob), which is a
    // legitimately-empty side, not an error.
    return "";
  }
}

/**
 * Full old/new content for a file under a target — the exact two blobs the diff
 * was computed from. The old side reads `oldPath` (which differs from `path` for
 * renames). A `null` side is unreadable/binary; `""` is a legitimately empty side.
 */
export async function readTargetFileContent(
  repoRoot: string,
  target: ReviewTarget,
  path: string,
  oldPath: string,
): Promise<FileContent> {
  const sides = await targetSides(repoRoot, target);
  const [oldContent, newContent] = await Promise.all([
    readSource(repoRoot, sides.old, oldPath),
    readSource(repoRoot, sides.new, path),
  ]);
  return { old: oldContent, new: newContent };
}

/** Write the editable/new side back to the working tree. */
export async function writeWorktreeFileContent(
  repoRoot: string,
  path: string,
  content: string,
): Promise<boolean> {
  const abs = containedPath(repoRoot, path);
  if (!abs) return false;

  try {
    if ((await lstat(resolve(repoRoot, path))).isSymbolicLink()) return false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }

  try {
    await writeFile(abs, content, "utf8");
    return true;
  } catch {
    return false;
  }
}
