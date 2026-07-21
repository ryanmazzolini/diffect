import { describe, expect, it } from "vitest";
import {
  applyPreciseReadingAnchorStep,
  beginReadingAnchorRestoration,
  isCurrentReadingAnchorRestoration,
} from "../src/readingAnchorRestoration.js";

const baseStep = {
  expectedScrollTop: 100,
  maxScrollDrift: 8,
  nextScreenTop: 120,
  anchorScreenTop: 100,
  scrollIntentChanged: false,
  retryCount: 0,
};

describe("precise reading-anchor restoration", () => {
  it("invalidates an older restoration when a newer refresh starts", () => {
    const state = { generation: 0 };
    const first = beginReadingAnchorRestoration(state);
    const second = beginReadingAnchorRestoration(state);

    expect(isCurrentReadingAnchorRestoration(state, first)).toBe(false);
    expect(isCurrentReadingAnchorRestoration(state, second)).toBe(true);
  });

  it("keeps independent restoration states isolated", () => {
    const firstRoot = { generation: 0 };
    const secondRoot = { generation: 0 };
    const secondRootGeneration = beginReadingAnchorRestoration(secondRoot);

    beginReadingAnchorRestoration(firstRoot);
    beginReadingAnchorRestoration(firstRoot);

    expect(isCurrentReadingAnchorRestoration(secondRoot, secondRootGeneration)).toBe(true);
  });

  it("applies a correction after bounded layout drift", () => {
    const scrollRoot = { scrollTop: 105 };

    expect(applyPreciseReadingAnchorStep({ scrollRoot, ...baseStep })).toEqual({
      status: "settled",
    });
    expect(scrollRoot.scrollTop).toBe(125);
  });

  it("preserves explicit scroll intent", () => {
    const scrollRoot = { scrollTop: 100 };

    expect(applyPreciseReadingAnchorStep({
      scrollRoot,
      ...baseStep,
      scrollIntentChanged: true,
    })).toEqual({ status: "interrupted" });
    expect(scrollRoot.scrollTop).toBe(100);
  });

  it("preserves scroll movement beyond the layout allowance", () => {
    const scrollRoot = { scrollTop: 109 };

    expect(applyPreciseReadingAnchorStep({ scrollRoot, ...baseStep })).toEqual({
      status: "interrupted",
    });
    expect(scrollRoot.scrollTop).toBe(109);
  });

  it("retries a clamped correction from the applied scroll position", () => {
    let scrollTop = 100;
    let maximumScrollTop = 110;
    const scrollRoot = {
      get scrollTop() {
        return scrollTop;
      },
      set scrollTop(value: number) {
        scrollTop = Math.min(value, maximumScrollTop);
      },
    };

    const first = applyPreciseReadingAnchorStep({ scrollRoot, ...baseStep });
    expect(first).toEqual({
      status: "retry",
      expectedScrollTop: 110,
      retryCount: 1,
    });
    expect(scrollRoot.scrollTop).toBe(110);

    maximumScrollTop = 130;
    if (first.status !== "retry") throw new Error("expected a retry");
    expect(applyPreciseReadingAnchorStep({
      scrollRoot,
      ...baseStep,
      expectedScrollTop: first.expectedScrollTop,
      nextScreenTop: 110,
      retryCount: first.retryCount,
    })).toEqual({ status: "settled" });
    expect(scrollRoot.scrollTop).toBe(120);
  });

  it("bounds repeated clamped corrections", () => {
    let scrollTop = 100;
    const scrollRoot = {
      get scrollTop() {
        return scrollTop;
      },
      set scrollTop(_value: number) {
        scrollTop = 100;
      },
    };

    expect(applyPreciseReadingAnchorStep({
      scrollRoot,
      ...baseStep,
      retryCount: 3,
    })).toEqual({ status: "exhausted" });
  });
});
