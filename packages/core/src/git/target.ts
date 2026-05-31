import type { DiffFile, RepoDiff, ReviewTarget } from "@diffect/shared";
import { git } from "./exec.js";
import {
  computeWorkDiff,
  parseUnifiedDiff,
  resolveWorkBase,
  syntheticUntrackedDiffs,
} from "./diff.js";

/**
 * Normalize a user-facing target spec into one ReviewTarget shape. Accepts the
 * Diffity-style keywords plus raw git refs/ranges:
 *   work | staged | unstaged | <ref> | <a>..<b>
 * Defaults to `work` when the spec is empty.
 */
export function normalizeTarget(spec: string | null | undefined): ReviewTarget {
  const s = (spec ?? "work").trim();
  if (s === "" || s === "work") return { spec: "work", kind: "work" };
  if (s === "staged" || s === "--cached" || s === "cached")
    return { spec: s, kind: "staged" };
  if (s === "unstaged") return { spec: s, kind: "unstaged" };

  // Range: three-dot (symmetric/merge-base) must be distinguished from two-dot.
  const threeDot = /^(.+?)\.\.\.(.+)$/.exec(s);
  if (threeDot) {
    return { spec: s, kind: "range", from: threeDot[1], to: threeDot[2], threeDot: true };
  }
  const twoDot = /^(.+?)\.\.(.+)$/.exec(s);
  if (twoDot) {
    return { spec: s, kind: "range", from: twoDot[1], to: twoDot[2], threeDot: false };
  }
  // Anything else is a single ref compared against the working tree.
  return { spec: s, kind: "ref", from: s };
}

/** Compute the diff for any normalized target in a repo working tree. */
export async function computeTargetDiff(
  repoRoot: string,
  target: ReviewTarget,
): Promise<RepoDiff> {
  switch (target.kind) {
    case "work":
      return computeWorkDiff(repoRoot);

    case "staged": {
      const files = await diffArgs(repoRoot, ["--cached"]);
      return { repo: ".", target: target.spec, files };
    }

    case "unstaged": {
      // Tracked worktree-vs-index changes, plus untracked files.
      const tracked = await diffArgs(repoRoot, []);
      const untracked = await syntheticUntrackedDiffs(repoRoot);
      return { repo: ".", target: target.spec, files: [...tracked, ...untracked] };
    }

    case "ref": {
      // <ref> vs working tree, plus untracked (mirrors `work` but against an
      // explicit ref instead of the merge-base).
      const tracked = await diffArgs(repoRoot, [target.from!]);
      const untracked = await syntheticUntrackedDiffs(repoRoot);
      return { repo: ".", target: target.spec, files: [...tracked, ...untracked] };
    }

    case "range": {
      // Pure commit range — no working tree, no untracked. Preserve dot count;
      // three-dot is the symmetric (merge-base) comparison.
      const op = target.threeDot ? "..." : "..";
      const files = await diffArgs(repoRoot, [`${target.from}${op}${target.to}`]);
      return { repo: ".", target: target.spec, files };
    }
  }
}

/** Run `git diff` with the given range/flags and parse the unified output. */
async function diffArgs(repoRoot: string, args: string[]): Promise<DiffFile[]> {
  const { stdout } = await git(repoRoot, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--find-renames",
    "--find-copies",
    ...args,
    "--",
  ]);
  return parseUnifiedDiff(stdout);
}

export { resolveWorkBase };
