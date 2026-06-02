export type Theme = "dark" | "light";

const KEY = "diffect-theme";

/** The persisted theme; absent a stored choice, follows the OS preference (dark default). */
export function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* localStorage may be unavailable (private mode, etc.) */
  }
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  } catch {
    return "dark";
  }
}

/** Apply a theme to the document and persist it. */
export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* persistence is best-effort */
  }
}
