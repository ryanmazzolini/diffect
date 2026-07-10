type TauriInternals = {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

export function isDesktopShell(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("shell") === "desktop";
}

export function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) return Promise.reject(new Error("Desktop shell is not available"));
  return invoke<T>(command, args);
}
