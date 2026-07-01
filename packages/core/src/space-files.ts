import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { containedPath, realpathSafe } from "./path-safe.js";
import { toLines } from "./reviews/anchors.js";

const SKIP_DIRS = new Set([
  ".git",
  ".reviews",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  "target",
]);

export async function listSpaceFiles(
  workspaceRoot: string,
  repoRoots: string[],
): Promise<{ files: string[] }> {
  const root = realpathSafe(resolve(workspaceRoot));
  const skipRoots = new Set(repoRoots.map((r) => realpathSafe(resolve(r))));
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    const real = realpathSafe(dir);
    if (skipRoots.has(real)) return;
    let entries;
    try {
      entries = await readdir(real, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".plans") continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = resolve(real, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, abs).split(sep).join("/");
      if (rel && containedPath(root, rel)) files.push(rel);
    }
  }

  await walk(root);
  return { files: files.sort((a, b) => a.localeCompare(b)) };
}

export async function readSpaceFileLines(
  workspaceRoot: string,
  file: string,
): Promise<string[] | null> {
  const abs = containedPath(workspaceRoot, file);
  if (!abs) return null;
  try {
    const content = await readFile(abs, "utf8");
    if (content.includes("\0")) return null;
    return toLines(content);
  } catch {
    return null;
  }
}
