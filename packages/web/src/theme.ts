export type Theme = "dark" | "light";

const KEY = "diffect-theme";

/** The persisted theme, defaulting to dark (the original look). */
export function getStoredTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark"; // localStorage may be unavailable (private mode, etc.)
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
