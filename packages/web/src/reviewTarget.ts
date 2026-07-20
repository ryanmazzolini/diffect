import type { OpenReviewSummary, ReviewTargetPresentation } from "@diffect/shared";

const STAGED_TARGETS = new Set(["staged", "--cached", "cached"]);

export interface ReviewSelection {
  worktree: string | null;
  target: string;
  presentation?: ReviewTargetPresentation;
}

export interface ReviewRequestContext {
  label: string;
  sessionId?: string;
}

export type ReviewRequestState =
  | {
      status: "loading";
      selection: ReviewSelection;
      context: ReviewRequestContext;
    }
  | {
      status: "error";
      selection: ReviewSelection;
      context: ReviewRequestContext;
      message: string;
    };

export type OpenReviewsState =
  | { status: "loading"; reviews: OpenReviewSummary[] }
  | { status: "ready"; reviews: OpenReviewSummary[] }
  | { status: "error"; reviews: OpenReviewSummary[]; message: string };

/** True when a review target reads its new side from the editable working tree. */
export function hasWorkingTreeSide(target: string): boolean {
  if (target === "work" || target === "unstaged" || target === "") return true;
  if (STAGED_TARGETS.has(target)) return false;
  // Git ref names cannot contain `..`, so every remaining non-range target is a
  // lone ref compared with the working tree.
  return !target.includes("..");
}
