import { createContext, useContext } from "react";

/**
 * Snapshot id of the diff currently on screen, or null when no single diff is in
 * view. A thread whose `snapshotId` differs from this was filed in an earlier
 * iteration of the same review — used to render a quiet, informational marker.
 *
 * This is deliberately NOT the "outdated" signal: outdatedness is `anchorState`
 * (the commented code actually moved or vanished). An earlier-iteration thread is
 * still anchored and current; the marker never hides, filters, resolves, or
 * reorders it.
 *
 * Provided once around the diff/thread panes so the shared `ThreadConversation`
 * leaf can read it without threading a prop through DiffView's memoized
 * render-extension callbacks, the out-of-diff preview, and the thread list — the
 * value is constant for the whole view and irrelevant to every component between.
 */
export const CurrentSnapshotContext = createContext<string | null>(null);

export function useCurrentSnapshot(): string | null {
  return useContext(CurrentSnapshotContext);
}
