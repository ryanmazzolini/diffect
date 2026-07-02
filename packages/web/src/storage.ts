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

export function removeStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* persistence is best-effort */
  }
}

export function getSessionStored(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setSessionStored(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* persistence is best-effort */
  }
}
