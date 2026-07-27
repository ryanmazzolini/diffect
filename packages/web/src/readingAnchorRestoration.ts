interface ScrollPosition {
  scrollTop: number;
}

export interface ScrollIntentState {
  epoch: number;
}

const scrollIntentByRoot = new WeakMap<HTMLElement, ScrollIntentState>();
const OVERLAY_SCROLLBAR_WIDTH = 12;
const SCROLL_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

function isVerticalScrollbarPointer(scrollRoot: HTMLElement, event: PointerEvent): boolean {
  if (event.target !== scrollRoot || scrollRoot.scrollHeight <= scrollRoot.clientHeight) {
    return false;
  }

  const rect = scrollRoot.getBoundingClientRect();
  if (event.clientY < rect.top || event.clientY > rect.bottom) return false;
  const scaleX = scrollRoot.offsetWidth > 0
    ? (rect.right - rect.left) / scrollRoot.offsetWidth
    : 1;
  const gutterLeft = rect.left + (scrollRoot.clientLeft + scrollRoot.clientWidth) * scaleX;
  // Overlay scrollbars do not reduce clientWidth. The app gives them a 12px
  // hit area in styles.css, so retain that edge as the fallback.
  const overlayLeft = rect.right - OVERLAY_SCROLLBAR_WIDTH * scaleX;
  return event.clientX >= Math.min(gutterLeft, overlayLeft) && event.clientX <= rect.right;
}

export function observeScrollIntent(scrollRoot: HTMLElement): ScrollIntentState {
  const existing = scrollIntentByRoot.get(scrollRoot);
  if (existing) return existing;

  const state: ScrollIntentState = { epoch: 0 };
  const markIntent = () => {
    state.epoch += 1;
  };
  scrollRoot.addEventListener("wheel", markIntent, { passive: true });
  scrollRoot.addEventListener("touchstart", markIntent, { passive: true });
  scrollRoot.addEventListener("pointerdown", (event) => {
    if (isVerticalScrollbarPointer(scrollRoot, event)) markIntent();
  }, { passive: true });
  scrollRoot.addEventListener("keydown", (event) => {
    if (SCROLL_KEYS.has(event.key)) markIntent();
  });
  scrollIntentByRoot.set(scrollRoot, state);
  return state;
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
