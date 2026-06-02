import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { AnchorState, Side, Thread, ThreadAnchor } from "@diffect/shared";
import { git } from "../git/exec.js";
import { containedPath } from "../path-safe.js";

/** Lines of surrounding context captured on each side of the anchored range. */
const CONTEXT_RADIUS = 3;

function sha256(s: string): string {
  return "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");
}

/** Split file content into lines, dropping a single trailing newline's empty tail. */
export function toLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Build the durable anchor for a new thread from the current file content. The
 * anchor hash identifies the exact commented range; the context hash
 * disambiguates it from identical lines elsewhere; the file hash is a coarse
 * staleness signal (a changed file does NOT by itself invalidate the thread).
 */
export function computeAnchor(
  fileLines: string[],
  line: number,
  endLine: number | null,
  baseSha: string | null,
): ThreadAnchor {
  const end = endLine ?? line;
  const range = sliceLines(fileLines, line, end);
  const before = sliceLines(fileLines, line - CONTEXT_RADIUS, line - 1);
  const after = sliceLines(fileLines, end + 1, end + CONTEXT_RADIUS);
  return {
    baseSha,
    anchorHash: sha256(range.join("\n")),
    contextHash: sha256([...before, "\u0000", ...after].join("\n")),
    fileHash: sha256(fileLines.join("\n")),
    hunkSnippet: range.join("\n").slice(0, 240),
  };
}

/** A thread's location for which to build a durable anchor. */
export interface AnchorTarget {
  file?: string | null;
  side?: Side | null;
  line?: number | null;
  endLine?: number | null;
}

/**
 * Build the durable anchor for a new thread from the file content at creation
 * time. Returns null for general (non-line) threads or unreadable files. Shared
 * by the daemon and the CLI so both anchor identically into the same store.
 */
export async function buildAnchor(
  repoRoot: string,
  base: string | null,
  target: AnchorTarget,
): Promise<ThreadAnchor | null> {
  if (!target.file || target.line == null) return null;
  const lines = await readSideLines(repoRoot, target.file, target.side ?? "new", base);
  if (!lines) return null;
  return computeAnchor(lines, target.line, target.endLine ?? null, base);
}

/** 1-based inclusive slice; out-of-range indices are clamped/skipped. */
function sliceLines(lines: string[], from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = Math.max(1, from); i <= to && i <= lines.length; i++) {
    out.push(lines[i - 1]!);
  }
  return out;
}

export interface ReanchorResult {
  /** null only for legacy/general threads that had no line to begin with. */
  line: number | null;
  endLine: number | null;
  anchorState: AnchorState;
}

/**
 * Re-locate an anchored thread against the current file content:
 *   1. file unchanged (fileHash matches) -> keep position, active
 *   2. exact range still at the stored line -> active
 *   3. range found elsewhere (nearest match, context-preferred) -> active, moved
 *   4. nothing matches -> stale (never dropped)
 */
export function reanchor(
  anchor: ThreadAnchor | null,
  line: number | null,
  endLine: number | null,
  fileLines: string[],
): ReanchorResult {
  // No anchor metadata (legacy thread) or no line: nothing to recompute.
  if (!anchor || line === null || anchor.anchorHash === null) {
    return { line, endLine, anchorState: "active" };
  }
  const len = (endLine ?? line) - line + 1;

  // Fast path: whole file identical -> the stored position is exact.
  if (anchor.fileHash && anchor.fileHash === sha256(fileLines.join("\n"))) {
    return { line, endLine, anchorState: "active" };
  }

  // Exact: the range still hashes the same at the stored line.
  if (rangeHashAt(fileLines, line, len) === anchor.anchorHash) {
    return { line, endLine, anchorState: "active" };
  }

  // Search: find the closest position whose range hash matches, breaking ties
  // toward one whose surrounding context also matches.
  let best: { start: number; dist: number; ctx: boolean } | null = null;
  for (let start = 1; start + len - 1 <= fileLines.length; start++) {
    if (rangeHashAt(fileLines, start, len) !== anchor.anchorHash) continue;
    const ctx = contextHashAt(fileLines, start, len) === anchor.contextHash;
    const dist = Math.abs(start - line);
    if (
      !best ||
      (ctx && !best.ctx) ||
      (ctx === best.ctx && dist < best.dist)
    ) {
      best = { start, dist, ctx };
    }
  }
  if (best) {
    return {
      line: best.start,
      endLine: endLine === null ? null : best.start + len - 1,
      anchorState: "active",
    };
  }

  // The commented range is gone — keep the thread but flag it.
  return { line, endLine, anchorState: "stale" };
}

function rangeHashAt(lines: string[], start: number, len: number): string | null {
  if (start < 1 || start + len - 1 > lines.length) return null;
  return sha256(sliceLines(lines, start, start + len - 1).join("\n"));
}

function contextHashAt(lines: string[], start: number, len: number): string {
  const end = start + len - 1;
  const before = sliceLines(lines, start - CONTEXT_RADIUS, start - 1);
  const after = sliceLines(lines, end + 1, end + CONTEXT_RADIUS);
  return sha256([...before, "\u0000", ...after].join("\n"));
}

/** Where a thread's repo lives on disk, plus the base it was anchored against. */
export interface RepoLocation {
  root: string;
  base: string | null;
}

/**
 * Recompute every file-anchored thread's position and stale state against the
 * current code. Threads whose repo cannot be resolved, or which carry no
 * anchor, are returned unchanged. Side/file content is read once and cached.
 */
export async function refreshAnchors(
  threads: Thread[],
  resolveRepo: (repo: string, worktree: string | null) => RepoLocation | undefined,
): Promise<Thread[]> {
  const cache = new Map<string, string[] | null>();

  const out: Thread[] = [];
  for (const t of threads) {
    if (!t.file || t.line === null || !t.side || !t.anchor) {
      out.push(t);
      continue;
    }
    const loc = resolveRepo(t.repo, t.worktree);
    if (!loc) {
      out.push(t);
      continue;
    }
    const key = `${loc.root}\u0000${t.side}\u0000${t.file}`;
    let lines = cache.get(key);
    if (lines === undefined) {
      lines = await readSideLines(loc.root, t.file, t.side, t.anchor.baseSha ?? loc.base);
      cache.set(key, lines);
    }
    if (lines === null) {
      // File is gone/unreadable: the anchor can't be found -> stale, not dropped.
      out.push({ ...t, anchorState: "stale" });
      continue;
    }
    const r = reanchor(t.anchor, t.line, t.endLine, lines);
    out.push({ ...t, line: r.line, endLine: r.endLine, anchorState: r.anchorState });
  }
  return out;
}

/**
 * Read the current content of a reviewed file for the given side:
 *   - "new": the working-tree file
 *   - "old": the file at the base commit (stable within a review)
 * Returns null when the file cannot be read (e.g. deleted) or is binary.
 */
export async function readSideLines(
  repoRoot: string,
  file: string,
  side: Side,
  baseSha: string | null,
): Promise<string[] | null> {
  if (side === "old") {
    if (!baseSha) return null;
    try {
      // Use git (not gitTry) so blob content is not trimmed.
      const { stdout } = await git(repoRoot, ["show", `${baseSha}:${file}`]);
      if (stdout.includes("\0")) return null;
      return toLines(stdout);
    } catch {
      return null; // path absent at base
    }
  }
  // Guard against path traversal: `file` may be user-supplied (a comment's path
  // or the unfold endpoint's ?path=), so confine the read to the repo.
  const abs = containedPath(repoRoot, file);
  if (!abs) return null;
  try {
    const content = await readFile(abs, "utf8");
    if (content.includes("\0")) return null;
    return toLines(content);
  } catch {
    return null;
  }
}
