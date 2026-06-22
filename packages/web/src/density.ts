export type Density = "tight" | "compact";

const KEY = "diffect-density";

/** The persisted density; "tight" (Linear-default) when no choice is stored. */
export function getStoredDensity(): Density {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "tight" || stored === "compact") return stored;
  } catch {
    /* localStorage may be unavailable (private mode, etc.) */
  }
  return "tight";
}

/** Apply a density to the document and persist it. */
export function setDensity(density: Density): void {
  document.documentElement.dataset.density = density;
  try {
    localStorage.setItem(KEY, density);
  } catch {
    /* persistence is best-effort */
  }
}
