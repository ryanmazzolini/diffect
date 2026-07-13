const STAGED_TARGETS = new Set(["staged", "--cached", "cached"]);

/** True when a review target reads its new side from the editable working tree. */
export function hasWorkingTreeSide(target: string): boolean {
  if (target === "work" || target === "unstaged" || target === "") return true;
  if (STAGED_TARGETS.has(target)) return false;
  // Git ref names cannot contain `..`, so every remaining non-range target is a
  // lone ref compared with the working tree.
  return !target.includes("..");
}
