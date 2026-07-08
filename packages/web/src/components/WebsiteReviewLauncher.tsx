import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { api } from "../api.js";
import { getStored, setStored } from "../storage.js";
import { invokeDesktop, isDesktopShell } from "../tauri.js";

const URL_KEY = "diffect-website-review-url";

type ReviewMode = "code" | "website";
type ReviewTool = "pick" | "area";
type Bounds = { x: number; y: number; width: number; height: number };
type Screenshot = { name: string; mime: string; bytes: number[] };
type Pick = {
  url: string;
  selector: string;
  text: string;
  bounds: Bounds;
  screenshot: Screenshot | null;
  screenshotError: string;
};

interface Props {
  children: ReactNode;
  repo: string | null;
  spacePath: string | null;
  worktree: string | null;
  target: string;
  onError: (message: string) => void;
  onThreadCreated: () => void;
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

function fieldString(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field.trim() : "";
}

function fieldBounds(value: unknown): Bounds | null {
  if (!value || typeof value !== "object") return null;
  const bounds = (value as Record<string, unknown>).bounds;
  if (!bounds || typeof bounds !== "object") return null;
  const b = bounds as Record<string, unknown>;
  if (!["x", "y", "width", "height"].every((key) => typeof b[key] === "number")) return null;
  return {
    x: Math.round(b.x as number),
    y: Math.round(b.y as number),
    width: Math.round(b.width as number),
    height: Math.round(b.height as number),
  };
}

function fieldScreenshot(value: unknown): Screenshot | null {
  if (!value || typeof value !== "object") return null;
  const screenshot = (value as Record<string, unknown>).screenshot;
  if (!screenshot || typeof screenshot !== "object") return null;
  const s = screenshot as Record<string, unknown>;
  if (typeof s.name !== "string" || typeof s.mime !== "string" || !Array.isArray(s.bytes)) {
    return null;
  }
  if (!s.bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return null;
  return { name: s.name, mime: s.mime, bytes: s.bytes as number[] };
}

function pickFromDetail(detail: unknown): Pick | null {
  const bounds = fieldBounds(detail);
  const url = fieldString(detail, "url");
  if (!bounds || !url) return null;
  return {
    url,
    selector: fieldString(detail, "selector"),
    text: fieldString(detail, "text"),
    bounds,
    screenshot: fieldScreenshot(detail),
    screenshotError: fieldString(detail, "screenshotError"),
  };
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function metadataBlock(pick: Pick): string {
  const rect = `${pick.bounds.x},${pick.bounds.y} ${pick.bounds.width}×${pick.bounds.height}`;
  return [
    "<!-- diffect-website-pick",
    JSON.stringify({ url: pick.url, selector: pick.selector, bounds: pick.bounds }),
    "-->",
    `Website: ${pick.url}`,
    pick.selector ? `Selector: ${inlineCode(pick.selector)}` : null,
    `Bounds: ${inlineCode(rect)}`,
    pick.text ? `Text: ${pick.text}` : null,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function WebsiteReviewLauncher({
  children,
  repo,
  spacePath,
  worktree,
  target,
  onError,
  onThreadCreated,
}: Props) {
  const [url, setUrl] = useState(() => getStored(URL_KEY) ?? "");
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [reviewReady, setReviewReady] = useState(false);
  const [reviewMode, setReviewMode] = useState<ReviewMode>("code");
  const [reviewTool, setReviewTool] = useState<ReviewTool>("pick");
  const [opening, setOpening] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setReviewReady(false);
    setActiveUrl(null);
    setReviewMode("code");
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

  const setNativeVisible = useCallback(
    (visible: boolean) => invokeDesktop<void>("set_website_review_visible", { visible }),
    [],
  );

  const changeTool = useCallback(
    (tool: ReviewTool) => {
      setReviewTool(tool);
      if (reviewReady) {
        void invokeDesktop<void>("set_website_review_tool", { tool }).catch((error) =>
          onError(String(error)),
        );
      }
    },
    [onError, reviewReady],
  );

  useEffect(() => {
    if (!reviewReady || reviewMode !== "code") return;
    void setNativeVisible(false).catch((error) => onError(String(error)));
  }, [onError, reviewMode, reviewReady, setNativeVisible]);

  useEffect(() => {
    if (!reviewReady) return;
    void invokeDesktop<void>("set_website_review_tool", { tool: reviewTool }).catch((error) =>
      onError(String(error)),
    );
  }, [onError, reviewReady, reviewTool]);

  useLayoutEffect(() => {
    if (!reviewReady || reviewMode !== "website") return;
    const sync = () => {
      void place("position_website_review")
        .then(() => setNativeVisible(true))
        .catch((error) => onError(String(error)));
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
  }, [onError, place, reviewMode, reviewReady, setNativeVisible]);

  useEffect(() => {
    const onPick = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      const pick = pickFromDetail(detail);
      const body = fieldString(detail, "body");
      if (!pick || !body || !repo || !spacePath) return;
      void (async () => {
        let nextBody = body;
        if (pick.screenshot) {
          const bytes = new Uint8Array(pick.screenshot.bytes);
          const file = new File([bytes], pick.screenshot.name, { type: pick.screenshot.mime });
          const attachment = await api.uploadAttachment(file);
          nextBody = `![${attachment.name}](${attachment.url})\n\n${nextBody}`;
        } else if (pick.screenshotError) {
          nextBody = `${nextBody}\n\nScreenshot failed: ${pick.screenshotError}`;
        }
        await api.createThread({
          repo,
          spacePath,
          worktree,
          target,
          targetLevel: "repo",
          file: null,
          side: null,
          line: null,
          body: `${nextBody}\n\n${metadataBlock(pick)}`,
        });
        onThreadCreated();
      })().catch((error) => onError(String(error)));
    };
    window.addEventListener("diffect:website-pick", onPick);
    return () => window.removeEventListener("diffect:website-pick", onPick);
  }, [onError, onThreadCreated, repo, spacePath, target, worktree]);

  if (!isDesktopShell()) return <>{children}</>;

  const open = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = url.trim();
    if (!next) return;
    setOpening(true);
    setActiveUrl(next);
    setReviewMode("website");
    try {
      setStored(URL_KEY, next);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await place("open_website_review", next);
      setReviewReady(true);
    } catch (error) {
      onError(String(error));
      setReviewReady(false);
      setActiveUrl(null);
      setReviewMode("code");
    } finally {
      setOpening(false);
    }
  };

  const codeActive = reviewMode === "code";

  return (
    <section className="website-review-shell">
      {activeUrl ? (
        <div className="website-review-tabs" role="tablist" aria-label="Review mode">
          <button
            type="button"
            role="tab"
            aria-selected={codeActive}
            className={`website-review-tab${codeActive ? " active" : ""}`}
            onClick={() => setReviewMode("code")}
          >
            Code
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!codeActive}
            className={`website-review-tab${!codeActive ? " active" : ""}`}
            onClick={() => setReviewMode("website")}
          >
            Preview
          </button>
          <span className="website-review-toolbar-divider" aria-hidden="true" />
          <div className="website-review-device" aria-label="Preview size">
            <span aria-hidden="true">▣</span>
            Desktop
            <span aria-hidden="true">⌄</span>
          </div>
          <span className="website-review-tab-spacer" />
          <div className="website-review-tool-group" aria-label="Preview tools">
            <button
              type="button"
              className={`website-review-tool${reviewTool === "area" ? " active" : ""}`}
              aria-pressed={reviewTool === "area"}
              onClick={() => changeTool("area")}
              title="Drag an area"
            >
              <span aria-hidden="true">▢</span>
              Area
            </button>
            <button
              type="button"
              className={`website-review-tool${reviewTool === "pick" ? " active" : ""}`}
              aria-pressed={reviewTool === "pick"}
              onClick={() => changeTool("pick")}
              title="Pick an element"
            >
              <span aria-hidden="true">✎</span>
              Pick
            </button>
          </div>
          <button type="button" className="ghost website-review-close" onClick={close}>Close preview</button>
        </div>
      ) : (
        <form className="website-review-openbar" onSubmit={open}>
          <label htmlFor="website-review-url">Open preview</label>
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
        </form>
      )}

      {activeUrl && reviewMode === "website" ? (
        <section className="website-review-surface" aria-label="Website preview">
          <div ref={viewportRef} className="website-review-viewport" />
        </section>
      ) : (
        <div className="website-review-code">{children}</div>
      )}
    </section>
  );
}
