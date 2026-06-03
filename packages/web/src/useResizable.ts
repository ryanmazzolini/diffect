import { useCallback, useEffect, useState, type MouseEvent, type RefObject } from "react";
import { getStored, setStored } from "./storage.js";

interface Options {
  /** localStorage key the chosen width is persisted under. */
  storageKey: string;
  /** CSS custom property the width is written to during a drag (e.g. "--thread-w"). */
  cssVar: string;
  defaultWidth: number;
  min: number;
  max: number;
  /** Right-side panes grow as the pointer moves left; set true for those. */
  invert?: boolean;
}

/**
 * A draggable pane width. The committed width is React state (rendered as an
 * inline CSS variable by the caller, so it survives reloads and re-renders); the
 * *drag* writes that same variable imperatively, rAF-coalesced, so a large diff
 * never re-renders mid-drag. State — and thus the diff tree — is only touched
 * once on release. That's the difference between a smooth handle and one that
 * stutters on big diffs.
 */
export function useResizable(
  container: RefObject<HTMLElement | null>,
  { storageKey, cssVar, defaultWidth, min, max, invert }: Options,
): { width: number; startResize: (e: MouseEvent) => void } {
  const [width, setWidth] = useState<number>(() => {
    const v = Number(getStored(storageKey));
    return Number.isFinite(v) && v >= min && v <= max ? v : defaultWidth;
  });

  useEffect(() => setStored(storageKey, String(width)), [width, storageKey]);

  const startResize = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      const el = container.current;
      if (!el) return;
      const startX = e.clientX;
      const startW = width;
      let latest = startW;
      let pendingX = startX;
      let raf = 0;
      const apply = () => {
        raf = 0;
        const delta = invert ? startX - pendingX : pendingX - startX;
        latest = Math.min(max, Math.max(min, startW + delta));
        el.style.setProperty(cssVar, `${latest}px`); // imperative: no React render
      };
      const onMove = (ev: globalThis.MouseEvent) => {
        pendingX = ev.clientX;
        if (!raf) raf = requestAnimationFrame(apply);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (raf) cancelAnimationFrame(raf);
        apply(); // flush the final pointer position
        document.body.style.userSelect = "";
        document.body.classList.remove("pane-resizing");
        setWidth(latest); // commit once → persist + reconcile React state
      };
      document.body.style.userSelect = "none"; // no text selection while dragging
      // While dragging, render diff lines no-wrap so a width change doesn't re-run
      // line-breaking on every frame (the remaining resize cost on big diffs).
      document.body.classList.add("pane-resizing");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [width, container, cssVar, min, max, invert],
  );

  return { width, startResize };
}
