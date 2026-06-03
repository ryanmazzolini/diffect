import { useCallback, useEffect, useRef, useState } from "react";
import type { Side } from "@diffect/shared";

interface Sel {
  side: Side;
  anchor: number;
  head: number;
}
type Range = { side: Side; lo: number; hi: number };
type FormRange = { side: Side; start: number; end: number };

export interface LineSelection {
  /** Inclusive line range currently highlighted (on one side), or null. */
  range: Range | null;
  /** The range the comment form is open for, or null. */
  form: FormRange | null;
  /** Props for a commentable gutter cell (the new- or old-side line number). */
  gutterProps: (side: Side, lineNo: number) => GutterProps;
  /** Props for a commentable line row, so a drag extends as it passes over it. */
  rowProps: (side: Side, lineNo: number) => { onPointerEnter: () => void };
  /** Props for the inline "+" button, so press-and-drag selects like the gutter. */
  commentButtonProps: (
    side: Side,
    lineNo: number,
  ) => { onPointerDown: (e: React.PointerEvent<HTMLElement>) => void };
  /** Open the comment form for a line (extends to the active range if it covers it). */
  openComment: (side: Side, lineNo: number) => void;
  closeForm: () => void;
}

interface GutterProps {
  role: "button";
  tabIndex: 0;
  "aria-label": string;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerEnter: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
}

const rangeOf = (s: Sel): Range => ({
  side: s.side,
  lo: Math.min(s.anchor, s.head),
  hi: Math.max(s.anchor, s.head),
});

/**
 * Line selection for a diff file, per side. Added/context lines select on the
 * new side; removed lines select on the old side. A selection stays within one
 * side (you can't drag a range across a deletion boundary). A drag can begin on
 * the line-number cell or the inline "+", and extends over any commentable row.
 * Input modes: click / shift-click to select; click-and-drag (auto-opens the
 * form on release); keyboard Enter/Space to comment and Shift+Arrow to extend.
 *
 * @param maxLineForSide last selectable line number on a given side, used to
 *   clamp keyboard range extension so the head can't run past a rendered row.
 */
export function useLineSelection(
  maxLineForSide: (side: Side) => number,
): LineSelection {
  const [sel, setSel] = useState<Sel | null>(null);
  const [form, setForm] = useState<FormRange | null>(null);
  // Refs the global pointerup handler reads without re-subscribing each render.
  const dragging = useRef(false);
  const moved = useRef(false);
  const dragSide = useRef<Side | null>(null);
  const dragAnchor = useRef<number | null>(null);
  const selRef = useRef<Sel | null>(null);
  selRef.current = sel;

  const range = sel ? rangeOf(sel) : null;

  const closeForm = useCallback(() => {
    setForm(null);
    setSel(null);
  }, []);

  const openComment = useCallback((side: Side, lineNo: number) => {
    const r = selRef.current ? rangeOf(selRef.current) : null;
    const inRange =
      r !== null && r.side === side && lineNo >= r.lo && lineNo <= r.hi;
    const start = inRange ? r.lo : lineNo;
    const end = inRange ? r.hi : lineNo;
    setForm({ side, start, end });
    setSel({ side, anchor: start, head: end });
  }, []);

  // Begin a drag from a line. `setNow` paints the single-line selection
  // immediately (gutter click) vs. only arming the drag (the + button, so a
  // plain click can still comment on a pre-existing range without wiping it).
  // Shift keeps the current anchor and extends — but only within the same side.
  const begin = useCallback(
    (side: Side, lineNo: number, shiftKey: boolean, setNow: boolean) => {
      dragging.current = true;
      moved.current = false;
      dragSide.current = side;
      document.body.style.userSelect = "none";
      const prev = selRef.current;
      if (shiftKey && prev && prev.side === side) {
        dragAnchor.current = prev.anchor;
        if (setNow) setSel({ side, anchor: prev.anchor, head: lineNo });
      } else {
        dragAnchor.current = lineNo;
        if (setNow) setSel({ side, anchor: lineNo, head: lineNo });
      }
    },
    [],
  );

  // Extend the in-progress drag to a line the pointer moved over (same side only).
  const extend = useCallback((side: Side, lineNo: number) => {
    if (!dragging.current || dragSide.current !== side) return;
    moved.current = true;
    const anchor = dragAnchor.current ?? lineNo;
    setSel({ side, anchor, head: lineNo });
  }, []);

  // End-of-drag: a drag that actually moved across cells opens the form for the
  // resulting range; a plain click leaves the selection for the + / shift-click.
  const finishDrag = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.userSelect = "";
    if (moved.current && selRef.current) {
      const r = rangeOf(selRef.current);
      setForm({ side: r.side, start: r.lo, end: r.hi });
    }
    moved.current = false;
  }, []);

  useEffect(() => {
    window.addEventListener("pointerup", finishDrag);
    return () => {
      window.removeEventListener("pointerup", finishDrag);
      // If we unmount mid-drag (e.g. the diff reloads), restore the global style
      // so userSelect:none doesn't leak to the whole app.
      if (dragging.current) document.body.style.userSelect = "";
    };
  }, [finishDrag]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeForm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeForm]);

  const gutterProps = useCallback(
    (side: Side, lineNo: number): GutterProps => ({
      role: "button",
      tabIndex: 0,
      "aria-label": `Comment on ${side === "old" ? "removed " : ""}line ${lineNo}`,
      onPointerDown: (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); // suppress native text selection so drag wins
        // preventDefault also suppresses focus; restore it so a mouse click
        // hands off to the Shift+Arrow / Enter keyboard flow.
        e.currentTarget.focus();
        begin(side, lineNo, e.shiftKey, true);
      },
      onPointerEnter: () => extend(side, lineNo),
      onKeyDown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openComment(side, lineNo);
        } else if (e.shiftKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          e.preventDefault();
          const delta = e.key === "ArrowDown" ? 1 : -1;
          const max = maxLineForSide(side);
          setSel((prev) => {
            const base = prev ?? { side, anchor: lineNo, head: lineNo };
            if (base.side !== side) return { side, anchor: lineNo, head: lineNo };
            // Clamp within the side so head can't run past the last line into a
            // range whose end has no rendered row (the form would never open).
            const head = Math.min(max, Math.max(1, base.head + delta));
            return { side, anchor: base.anchor, head };
          });
        }
      },
    }),
    [openComment, maxLineForSide, begin, extend],
  );

  // The row's pointer-enter keeps a drag going when the pointer travels over the
  // code cells (e.g. a drag started from the + button) rather than the gutter.
  const rowProps = useCallback(
    (side: Side, lineNo: number) => ({
      onPointerEnter: () => extend(side, lineNo),
    }),
    [extend],
  );

  // The + starts a drag too. No preventDefault here: a plain click must still
  // fire onClick (single-line comment); userSelect:none already blocks native
  // text selection once this becomes a drag.
  const commentButtonProps = useCallback(
    (side: Side, lineNo: number) => ({
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        if (e.button !== 0) return;
        begin(side, lineNo, e.shiftKey, false);
      },
    }),
    [begin],
  );

  return {
    range,
    form,
    gutterProps,
    rowProps,
    commentButtonProps,
    openComment,
    closeForm,
  };
}
