// The durable, per-repo review state a module's status crumb (and, later, the
// repo rail) renders. Four resting states, derived purely from review *activity*
// rather than tree state: a diff with no comments is "idle"; once commented it's
// "in-progress" until every thread is resolved, then "ready" (offers Mark
// complete); archiving it makes it "archived" (offers Revive). Deliberately
// independent of the browser-local `dismissedComplete` — the crumb reports the
// true shared state, while the N=1 completion *banner* keeps its own `!dismissed`
// gate. See the mockup's state-legend (mockups/modules-view.html — "the four
// resting states").
export type Lifecycle = "idle" | "in-progress" | "ready" | "archived";

export function deriveLifecycle(args: {
  totalComments: number;
  openComments: number;
  archived: boolean;
}): Lifecycle {
  if (args.archived) return "archived";
  if (args.openComments > 0) return "in-progress";
  if (args.totalComments > 0) return "ready";
  return "idle";
}

// The crumb's visible label and the dot's modifier class per state. Kept beside
// the derivation so the rail and the crumb stay in lockstep on wording/hue.
export const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  idle: "Not started",
  "in-progress": "In progress",
  ready: "Ready",
  archived: "Archived",
};
export const LIFECYCLE_DOT: Record<Lifecycle, string> = {
  idle: "idle",
  "in-progress": "progress",
  ready: "ready",
  archived: "arch",
};
