import { describe, expect, it } from "vitest";
import {
  applyPreciseReadingAnchorStep,
  beginReadingAnchorRestoration,
  isCurrentReadingAnchorRestoration,
  observeScrollIntent,
} from "../src/readingAnchorRestoration.js";

const baseStep = {
  expectedScrollTop: 100,
  maxScrollDrift: 8,
  nextScreenTop: 120,
  anchorScreenTop: 100,
  scrollIntentChanged: false,
  retryCount: 0,
};

function testScrollRoot(clientWidth: number): HTMLElement {
  return Object.assign(new EventTarget(), {
    clientHeight: 200,
    clientLeft: 0,
    clientWidth,
    offsetWidth: 200,
    scrollHeight: 400,
    scrollTop: 100,
    getBoundingClientRect: () => ({ bottom: 200, left: 0, right: 200, top: 0 }),
  }) as unknown as HTMLElement;
}

function dispatchPointerDown(
  scrollRoot: HTMLElement,
  clientX: number,
  target: EventTarget = scrollRoot,
): void {
  const event = new Event("pointerdown");
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: 100 },
    ...(target === scrollRoot ? {} : { target: { value: target } }),
  });
  scrollRoot.dispatchEvent(event);
}

describe("precise reading-anchor restoration", () => {
  it.each([
    ["gutter", 188],
    ["overlay", 200],
  ])("recognizes %s native-scrollbar pointer intent", (_kind, clientWidth) => {
    const scrollRoot = testScrollRoot(clientWidth);
    const intent = observeScrollIntent(scrollRoot);

    dispatchPointerDown(scrollRoot, 195);

    expect(intent.epoch).toBe(1);
  });

  it.each([
    ["inside the root", 100, undefined],
    ["on an editor child at the scrollbar edge", 195, new EventTarget()],
  ])("does not treat an ordinary pointer %s as scroll intent", (_kind, clientX, target) => {
    const scrollRoot = testScrollRoot(188);
    const intent = observeScrollIntent(scrollRoot);

    dispatchPointerDown(scrollRoot, clientX, target);

    expect(intent.epoch).toBe(0);
  });

  it("preserves a small native-scrollbar movement during precise restoration", () => {
    const scrollRoot = testScrollRoot(188);
    const intent = observeScrollIntent(scrollRoot);
    const capturedEpoch = intent.epoch;

    dispatchPointerDown(scrollRoot, 195);
    scrollRoot.scrollTop += 5;

    expect(applyPreciseReadingAnchorStep({
      scrollRoot,
      ...baseStep,
      scrollIntentChanged: intent.epoch !== capturedEpoch,
    })).toEqual({ status: "interrupted" });
    expect(scrollRoot.scrollTop).toBe(105);
  });

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
