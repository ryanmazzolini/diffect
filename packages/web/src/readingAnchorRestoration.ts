interface ScrollPosition {
  scrollTop: number;
}

export interface ReadingAnchorRestorationState {
  generation: number;
}

interface PreciseReadingAnchorStep {
  scrollRoot: ScrollPosition;
  expectedScrollTop: number;
  maxScrollDrift: number;
  nextScreenTop: number;
  anchorScreenTop: number;
  scrollIntentChanged: boolean;
  retryCount: number;
}

export type PreciseReadingAnchorResult =
  | { status: "settled" }
  | { status: "interrupted" }
  | { status: "exhausted" }
  | { status: "retry"; expectedScrollTop: number; retryCount: number };

const SCROLL_TOLERANCE = 1;
const RETRY_LIMIT = 3;

export function beginReadingAnchorRestoration(state: ReadingAnchorRestorationState): number {
  state.generation += 1;
  return state.generation;
}

export function isCurrentReadingAnchorRestoration(
  state: ReadingAnchorRestorationState,
  generation: number,
): boolean {
  return state.generation === generation;
}

/** Applies one precise reading-anchor correction and describes the next step. */
export function applyPreciseReadingAnchorStep({
  scrollRoot,
  expectedScrollTop,
  maxScrollDrift,
  nextScreenTop,
  anchorScreenTop,
  scrollIntentChanged,
  retryCount,
}: PreciseReadingAnchorStep): PreciseReadingAnchorResult {
  const currentScrollTop = scrollRoot.scrollTop;
  if (
    scrollIntentChanged ||
    Math.abs(currentScrollTop - expectedScrollTop) > maxScrollDrift
  ) {
    return { status: "interrupted" };
  }

  const requestedScrollTop = currentScrollTop + nextScreenTop - anchorScreenTop;
  scrollRoot.scrollTop = requestedScrollTop;
  const appliedScrollTop = scrollRoot.scrollTop;
  if (Math.abs(appliedScrollTop - requestedScrollTop) <= SCROLL_TOLERANCE) {
    return { status: "settled" };
  }
  if (retryCount >= RETRY_LIMIT) return { status: "exhausted" };

  return {
    status: "retry",
    expectedScrollTop: appliedScrollTop,
    retryCount: retryCount + 1,
  };
}
