import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReviewSelectionIntentController } from "../src/reviewSelectionIntent.js";

describe("review selection intents", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("defers a comparison selection until the debounce expires", () => {
    const requests: string[] = [];
    const intents = createReviewSelectionIntentController(150);

    intents.schedule(() => requests.push("main...feature"));
    vi.advanceTimersByTime(149);
    expect(requests).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(requests).toEqual(["main...feature"]);
  });

  it("keeps only the latest deferred selection", () => {
    const requests: string[] = [];
    const intents = createReviewSelectionIntentController(150);

    intents.schedule(() => requests.push("main...feature"));
    intents.schedule(() => requests.push("main...release"));
    vi.advanceTimersByTime(150);

    expect(requests).toEqual(["main...release"]);
  });

  it("invalidates a deferred comparison before running an immediate local selection", () => {
    const requests: string[] = [];
    const intents = createReviewSelectionIntentController(150);

    intents.schedule(() => requests.push("main...feature"));
    const result = intents.runNow(() => {
      requests.push("staged");
      return true;
    });
    vi.advanceTimersByTime(150);

    expect(result).toBe(true);
    expect(requests).toEqual(["staged"]);
  });
});
