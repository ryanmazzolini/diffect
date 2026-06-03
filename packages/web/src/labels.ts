import type { ThreadStatus } from "@diffect/shared";

/**
 * User-facing label for a thread status. The stored value stays "resolved"
 * (and replays of legacy logs fold dismissed → resolved), but we show the more
 * compact "closed" in the UI.
 */
export function statusLabel(status: ThreadStatus | "all"): string {
  return status === "resolved" ? "closed" : status;
}
