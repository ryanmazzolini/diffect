import { describe, expect, it } from "vitest";
import { computeAnchor, reanchor, toLines } from "../src/reviews/anchors.js";

const FILE = [
  "import a",
  "import b",
  "",
  "function greet(name) {",
  "  return `hi ${name}`", // line 5 — the commented line
  "}",
  "",
  "export default greet",
];

function anchorAt(lines: string[], line: number, endLine: number | null = null) {
  return computeAnchor(lines, line, endLine, "base0");
}

describe("computeAnchor + reanchor", () => {
  it("keeps a thread active when the file is unchanged", () => {
    const a = anchorAt(FILE, 5);
    const r = reanchor(a, 5, null, FILE);
    expect(r).toEqual({ line: 5, endLine: null, anchorState: "active" });
  });

  it("follows the commented line when code is inserted above it", () => {
    const a = anchorAt(FILE, 5);
    const moved = ["// new banner", "// more", ...FILE]; // pushed down by 2
    const r = reanchor(a, 5, null, moved);
    expect(r.anchorState).toBe("active");
    expect(r.line).toBe(7);
    expect(moved[r.line - 1]).toBe("  return `hi ${name}`");
  });

  it("stays active across a nearby formatting change that doesn't touch the line", () => {
    const a = anchorAt(FILE, 5);
    const reformatted = [...FILE];
    reformatted[3] = "function greet( name ) {"; // line above reformatted
    const r = reanchor(a, 5, null, reformatted);
    expect(r.anchorState).toBe("active");
    expect(r.line).toBe(5);
  });

  it("goes stale when the commented range is deleted", () => {
    const a = anchorAt(FILE, 5);
    const deleted = FILE.filter((_, i) => i !== 4); // remove line 5
    const r = reanchor(a, 5, null, deleted);
    expect(r.anchorState).toBe("stale");
    // line is preserved (never silently relocated to the wrong place)
    expect(r.line).toBe(5);
  });

  it("goes stale when the commented line's content is edited away", () => {
    const a = anchorAt(FILE, 5);
    const edited = [...FILE];
    edited[4] = "  return name.toUpperCase()"; // changed content, unique
    const r = reanchor(a, 5, null, edited);
    expect(r.anchorState).toBe("stale");
  });

  it("a whole-file change does not invalidate a surviving anchored range", () => {
    const a = anchorAt(FILE, 5);
    // Every other line changes, but line 5's text survives intact.
    const churned = FILE.map((l, i) => (i === 4 ? l : l + " // touched"));
    const r = reanchor(a, 5, null, churned);
    expect(r.anchorState).toBe("active");
    expect(r.line).toBe(5);
  });

  it("disambiguates duplicate lines by surrounding context", () => {
    // Three identical "return x" lines; the middle one (line 6) is the anchor,
    // distinguished by its unique marker neighbours. Padding keeps the anchor
    // away from the file edges so its context window is full and stable.
    const dup = [
      "pad0", // 1
      "pad1", // 2
      "  return x", // 3  (occurrence 1)
      "pad2", // 4
      "marker A", // 5
      "  return x", // 6  <- anchor, between marker A and marker B
      "marker B", // 7
      "pad3", // 8
      "  return x", // 9  (occurrence 3)
      "pad4", // 10
    ];
    const a = anchorAt(dup, 6);
    // Insert two lines at the top: everything shifts down by 2, but the anchor's
    // local context (marker A / marker B) moves with it intact.
    const shifted = ["// new1", "// new2", ...dup];
    const r = reanchor(a, 6, null, shifted);
    expect(r.anchorState).toBe("active");
    expect(r.line).toBe(8); // the middle "return x" is now line 8
    expect(shifted[r.line - 2]).toBe("marker A");
    expect(shifted[r.line]).toBe("marker B");
  });

  it("handles a multi-line range that moves", () => {
    const a = anchorAt(FILE, 4, 6); // the whole function body
    const moved = ["// x", ...FILE];
    const r = reanchor(a, 4, 6, moved);
    expect(r.anchorState).toBe("active");
    expect(r.line).toBe(5);
    expect(r.endLine).toBe(7);
  });

  it("treats a thread with no anchor as active (legacy)", () => {
    const r = reanchor(null, 5, null, FILE);
    expect(r.anchorState).toBe("active");
  });
});

describe("toLines", () => {
  it("drops a single trailing newline's empty tail", () => {
    expect(toLines("a\nb\n")).toEqual(["a", "b"]);
    expect(toLines("a\nb")).toEqual(["a", "b"]);
    expect(toLines("")).toEqual([]);
  });
});
