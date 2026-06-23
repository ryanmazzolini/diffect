import { useEffect, useState, type MouseEvent, type RefObject } from "react";
import { getStored, setStored } from "./storage.js";
import { useResizable } from "./useResizable.js";

/**
 * State for the resizable, collapsible thread pane: a collapsed flag (persisted),
 * an imperative drag handler (see useResizable — no per-frame re-render), and the
 * grid-template-columns string, which reads the width from a CSS variable so the
 * drag never touches React state until release.
 */
export function usePaneLayout(container: RefObject<HTMLElement | null>): {
  collapsed: boolean;
  toggleCollapsed: () => void;
  startResize: (e: MouseEvent) => void;
  columns: string;
  width: number;
} {
  const [collapsed, setCollapsed] = useState<boolean>(
    () => getStored("diffect-pane-collapsed") === "1",
  );
  useEffect(
    () => setStored("diffect-pane-collapsed", collapsed ? "1" : "0"),
    [collapsed],
  );

  const { width, startResize } = useResizable(container, {
    storageKey: "diffect-pane-width",
    cssVar: "--thread-w",
    defaultWidth: 340,
    min: 240,
    max: 720,
    invert: true, // the pane is on the right, so dragging left widens it
  });

  return {
    collapsed,
    toggleCollapsed: () => setCollapsed((c) => !c),
    startResize,
    columns: collapsed ? "minmax(0, 1fr) 34px" : "minmax(0, 1fr) 6px var(--thread-w, 340px)",
    width,
  };
}
