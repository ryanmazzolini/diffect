import { useCallback, useEffect, useRef, useState } from "react";

interface Sel {
  anchor: number;
  head: number;
}
type Range = { lo: number; hi: number };
type FormRange = { start: number; end: number };

export interface LineSelection {
  /** Inclusive new-side line range currently highlighted, or null. */
  range: Range | null;
  /** The range the comment form is open for, or null. */
  form: FormRange | null;
  /** Props to spread onto a commentable gutter cell (new-side line number). */
  gutterProps: (lineNo: number) => GutterProps;
  /** Open the comment form for a line (extends to the active range if it covers it). */
  openComment: (lineNo: number) => void;
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
  lo: Math.min(s.anchor, s.head),
  hi: Math.max(s.anchor, s.head),
});

/**
 * Gutter line selection for a diff file. Supports three input modes over the
 * new-side line-number cells:
 *  - click + shift-click to select / extend a range (then comment via the +),
 *  - click-and-drag across cells, which auto-opens the comment form on release,
 *  - keyboard: Enter/Space comments on the focused line, Shift+Arrow extends.
 * Native text selection is suppressed during a drag so it doesn't fight the
 * range highlight.
 */
export function useLineSelection(maxLine: number): LineSelection {
  const [sel, setSel] = useState<Sel | null>(null);
  const [form, setForm] = useState<FormRange | null>(null);
  // Refs the global pointerup handler reads without re-subscribing each render.
  const dragging = useRef(false);
  const moved = useRef(false);
  const selRef = useRef<Sel | null>(null);
  selRef.current = sel;

  const range = sel ? rangeOf(sel) : null;

  const closeForm = useCallback(() => {
    setForm(null);
    setSel(null);
  }, []);

  const openComment = useCallback((lineNo: number) => {
    const r = selRef.current ? rangeOf(selRef.current) : null;
    const inRange = r !== null && lineNo >= r.lo && lineNo <= r.hi;
    const start = inRange ? r.lo : lineNo;
    const end = inRange ? r.hi : lineNo;
    setForm({ start, end });
    setSel({ anchor: start, head: end });
  }, []);

  // End-of-drag: a drag that actually moved across cells opens the form for the
  // resulting range; a plain click leaves the selection for the + / shift-click.
  const finishDrag = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.userSelect = "";
    if (moved.current && selRef.current) {
      const r = rangeOf(selRef.current);
      setForm({ start: r.lo, end: r.hi });
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
    (lineNo: number): GutterProps => ({
      role: "button",
      tabIndex: 0,
      "aria-label": `Comment on line ${lineNo}`,
      onPointerDown: (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); // suppress native text selection so drag wins
        // preventDefault also suppresses focus; restore it so a mouse click
        // hands off to the Shift+Arrow / Enter keyboard flow.
        e.currentTarget.focus();
        dragging.current = true;
        moved.current = false;
        document.body.style.userSelect = "none";
        setSel((prev) =>
          e.shiftKey && prev
            ? { anchor: prev.anchor, head: lineNo }
            : { anchor: lineNo, head: lineNo },
        );
      },
      onPointerEnter: () => {
        if (!dragging.current) return;
        moved.current = true;
        setSel((prev) => (prev ? { ...prev, head: lineNo } : null));
      },
      onKeyDown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openComment(lineNo);
        } else if (e.shiftKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          e.preventDefault();
          const delta = e.key === "ArrowDown" ? 1 : -1;
          setSel((prev) => {
            const base = prev ?? { anchor: lineNo, head: lineNo };
            // Clamp within the file so head can't run past the last line into a
            // range whose end has no rendered row (the form would never open).
            const head = Math.min(maxLine, Math.max(1, base.head + delta));
            return { anchor: base.anchor, head };
          });
        }
      },
    }),
    [openComment],
  );

  return { range, form, gutterProps, openComment, closeForm };
}
