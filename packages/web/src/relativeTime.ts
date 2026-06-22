/**
 * Compact relative time ("just now", "24m ago", "3h ago", "2d ago") from an ISO
 * timestamp, falling back to a locale date past a week. Returns "" for an
 * unparseable input so callers can render it inline without guarding.
 */
export function relativeTime(ts: string): string {
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}
