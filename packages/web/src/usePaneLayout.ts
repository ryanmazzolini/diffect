import { useEffect, useState, type MouseEvent } from "react";
import { getStored, setStored } from "./storage.js";

const MIN = 240;
const MAX = 720;

/**
 * State for the resizable, collapsible thread pane: width + collapsed flag
 * (persisted), a mouse-drag resize handler, and the grid-template-columns string.
 */
export function usePaneLayout() {
  const [width, setWidth] = useState<number>(() => {
    const v = Number(getStored("diffect-pane-width"));
    return Number.isFinite(v) && v >= MIN ? v : 340;
  });
  const [collapsed, setCollapsed] = useState<boolean>(
    () => getStored("diffect-pane-collapsed") === "1",
  );
  useEffect(() => setStored("diffect-pane-width", String(width)), [width]);
  useEffect(
    () => setStored("diffect-pane-collapsed", collapsed ? "1" : "0"),
    [collapsed],
  );

  // The pane is on the right, so dragging the handle left widens it.
  const startResize = (e: MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: globalThis.MouseEvent) =>
      setWidth(Math.min(MAX, Math.max(MIN, startW + (startX - ev.clientX))));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return {
    collapsed,
    toggleCollapsed: () => setCollapsed((c) => !c),
    startResize,
    columns: collapsed ? "1fr" : `minmax(0, 1fr) 6px ${width}px`,
  };
}
