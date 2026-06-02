import { useEffect, useState } from "react";
import { getStored, removeStored, setStored } from "./storage.js";

/**
 * A text value mirrored to localStorage so an in-progress comment/reply survives
 * a re-render, an SSE-driven diff reload, or an accidental cancel. The draft is
 * keyed by location (repo/file/line or thread id); `clear()` drops it on submit.
 */
export function useDraft(key: string): [string, (v: string) => void, () => void] {
  const [value, setValue] = useState(() => getStored(key) ?? "");

  useEffect(() => {
    if (value) setStored(key, value);
    else removeStored(key);
  }, [key, value]);

  // Clear storage synchronously so a submit-then-unmount race can't leave the
  // just-sent draft behind to reappear next time the form opens.
  const clear = () => {
    removeStored(key);
    setValue("");
  };

  return [value, setValue, clear];
}
