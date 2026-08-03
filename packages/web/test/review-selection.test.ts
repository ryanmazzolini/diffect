import { describe, expect, it } from "vitest";
import {
  locationFromSelection,
  reviewIdFromPath,
} from "../src/App.js";

describe("clean Review selection", () => {
  it("maps an inclusive Pierre range to a clean line location", () => {
    expect(
      locationFromSelection({
        id: "src/example.ts",
        range: {
          start: 8,
          end: 4,
          side: "additions",
          endSide: "additions",
        },
      }),
    ).toEqual({
      path: "src/example.ts",
      side: "new",
      startLine: 4,
      endLine: 8,
    });
  });

  it("rejects a mixed-side selection", () => {
    expect(
      locationFromSelection({
        id: "src/example.ts",
        range: {
          start: 4,
          end: 4,
          side: "deletions",
          endSide: "additions",
        },
      }),
    ).toBeNull();
  });

  it("accepts only canonical Review paths", () => {
    const id = `rvw_${"a".repeat(32)}`;
    expect(reviewIdFromPath(`/reviews/${id}`)).toBe(id);
    expect(reviewIdFromPath("/reviews/sess_legacy")).toBeNull();
    expect(reviewIdFromPath(`/reviews/${id}/extra`)).toBeNull();
  });
});
