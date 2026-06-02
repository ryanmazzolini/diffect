// Best-effort localStorage access (localStorage can throw in private mode).

export function getStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* persistence is best-effort */
  }
}
