import { lstat, readFile, readlink, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { FileContent } from "@diffect/shared";
import { containedPath } from "../path-safe.js";
import { resolveWorkBase } from "./diff.js";
import { git } from "./exec.js";

function blobInTree(path: string): boolean {
  return !isAbsolute(path) && !path.split("/").includes("..");
}

async function showBlob(repoRoot: string, spec: string): Promise<string | null> {
  try {
    const { stdout } = await git(repoRoot, ["show", spec]);
    return stdout.includes("\0") ? null : stdout;
  } catch {
    return "";
  }
}

async function readWorktreeFile(
  repoRoot: string,
  path: string,
): Promise<string | null> {
  const abs = containedPath(repoRoot, path);
  if (!abs) return null;
  const unresolved = resolve(repoRoot, path);
  try {
    if ((await lstat(unresolved)).isSymbolicLink()) return await readlink(unresolved);
  } catch {
    // Missing files are the empty new side of deletions.
  }
  try {
    const content = await readFile(abs, "utf8");
    return content.includes("\0") ? null : content;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "" : null;
  }
}

/** Full old/new contents for the canonical Current changes projection. */
export async function readWorkFileContent(
  repoRoot: string,
  path: string,
  oldPath: string,
): Promise<FileContent> {
  const base = await resolveWorkBase(repoRoot);
  const [oldContent, newContent] = await Promise.all([
    base && blobInTree(oldPath) ? showBlob(repoRoot, `${base}:${oldPath}`) : "",
    readWorktreeFile(repoRoot, path),
  ]);
  return { old: oldContent, new: newContent };
}

/** Retained for future editor handoff; clean Review routes are currently read-only. */
export async function writeWorktreeFileContent(
  repoRoot: string,
  path: string,
  content: string,
): Promise<boolean> {
  const abs = containedPath(repoRoot, path);
  if (!abs) return false;

  try {
    if ((await lstat(resolve(repoRoot, path))).isSymbolicLink()) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }

  try {
    await writeFile(abs, content, "utf8");
    return true;
  } catch {
    return false;
  }
}
