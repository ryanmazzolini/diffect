import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { getStored, setStored } from "../storage.js";
import { invokeDesktop, isDesktopShell } from "../tauri.js";

const URL_KEY = "diffect-website-review-url";

interface Props {
  onError: (message: string) => void;
}

function rectArgs(el: HTMLElement): Record<string, number> {
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

export function WebsiteReviewLauncher({ onError }: Props) {
  const [url, setUrl] = useState(() => getStored(URL_KEY) ?? "");
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [reviewReady, setReviewReady] = useState(false);
  const [opening, setOpening] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setReviewReady(false);
    setActiveUrl(null);
    void invokeDesktop<void>("close_website_review").catch((error) => onError(String(error)));
  }, [onError]);

  const place = useCallback(
    async (command: "open_website_review" | "position_website_review", nextUrl?: string) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const args = rectArgs(viewport);
      await invokeDesktop<void>(command, nextUrl ? { url: nextUrl, ...args } : args);
    },
    [],
  );

  useLayoutEffect(() => {
    if (!reviewReady) return;
    const sync = () => {
      void place("position_website_review").catch((error) => onError(String(error)));
    };
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    const observer = new ResizeObserver(sync);
    if (viewportRef.current) observer.observe(viewportRef.current);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
    };
  }, [onError, place, reviewReady]);

  useEffect(() => {
    if (!activeUrl) return;
    const onPick = () => close();
    window.addEventListener("diffect:website-pick", onPick);
    return () => window.removeEventListener("diffect:website-pick", onPick);
  }, [activeUrl, close]);

  if (!isDesktopShell()) return null;

  const open = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = url.trim();
    if (!next) return;
    setOpening(true);
    setActiveUrl(next);
    try {
      setStored(URL_KEY, next);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await place("open_website_review", next);
      setReviewReady(true);
    } catch (error) {
      onError(String(error));
      setReviewReady(false);
      setActiveUrl(null);
    } finally {
      setOpening(false);
    }
  };

  return (
    <>
      <form className="website-review-launcher" onSubmit={open}>
        <label htmlFor="website-review-url">Website Review</label>
        <div className="website-review-row">
          <input
            id="website-review-url"
            type="url"
            inputMode="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="http://127.0.0.1:5173"
          />
          <button type="submit" className="ghost" disabled={opening || !url.trim()}>
            {opening ? "Opening…" : "Open"}
          </button>
        </div>
      </form>
      {activeUrl && (
        <section className="website-review-panel" aria-label="Website Review">
          <div className="website-review-toolbar">
            <strong>Website Review</strong>
            <span title={activeUrl}>Picker active — click any element to comment · {activeUrl}</span>
            <button type="button" className="ghost" onClick={close}>Close</button>
          </div>
          <div ref={viewportRef} className="website-review-viewport" />
        </section>
      )}
    </>
  );
}
