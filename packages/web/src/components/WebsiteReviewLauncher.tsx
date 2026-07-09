import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { api } from "../api.js";
import { Icon, type IconName } from "../icons.js";
import { getStored, setStored } from "../storage.js";
import { invokeDesktop, isDesktopShell } from "../tauri.js";
import {
  isReviewableWebsiteUrl,
  mergeWebsiteBookmarks,
  readWebsiteAllowedDomains,
  readWebsiteBookmarks,
  readWebsiteHistory,
  recordWebsiteVisit,
  replaceWebsiteBookmarks,
  saveWebsiteAllowedDomains,
  sortWebsiteBookmarks,
  titleForUrl,
  toggleWebsiteBookmark,
  websiteSuggestions,
  type BookmarkImportCandidate,
  type WebsiteBookmark,
  type WebsiteBookmarkSort,
  type WebsiteSuggestion,
} from "../websiteReviewData.js";
import { Modal } from "./Modal.js";

const URL_KEY = "diffect-website-review-url";

type ReviewTool = "browse" | "pick" | "area";
type ViewportPreset = "desktop" | "tablet" | "mobile";
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

type BrowserBookmarkSource = {
  browser: string;
  profile: string;
  bookmarks: BookmarkImportCandidate[];
};

type BookmarkManagerMode = "bookmarks" | "domains";

const VIEWPORT_PRESETS: Record<ViewportPreset, { label: string; icon: IconName }> = {
  desktop: { label: "Desktop", icon: "device-desktop" },
  tablet: { label: "Tablet", icon: "device-tablet" },
  mobile: { label: "Mobile", icon: "device-mobile" },
};

const REVIEW_TOOLS: Record<ReviewTool, { label: string; title: string; icon: IconName }> = {
  browse: { label: "Pointer", title: "Interact with the page", icon: "cursor" },
  area: { label: "Area", title: "Drag an area to comment", icon: "square" },
  pick: { label: "Pick", title: "Pick an element to comment", icon: "pencil" },
};
const REVIEW_TOOL_ORDER: ReviewTool[] = ["browse", "area", "pick"];

interface Props {
  visible: boolean;
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

function normalizeAddress(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function urlKey(spacePath: string | null): string {
  return spacePath ? `${URL_KEY}:${spacePath}` : URL_KEY;
}

function spaceStateKey(spacePath: string | null): string {
  return spacePath ?? "__default__";
}

function collectChromeBookmarks(value: unknown): BookmarkImportCandidate[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url : "";
  const name = typeof record.name === "string" ? record.name : "";
  const own = url ? [{ url, title: name || titleForUrl(url) }] : [];
  const children = Array.isArray(record.children) ? record.children : [];
  const roots = record.roots && typeof record.roots === "object"
    ? Object.values(record.roots as Record<string, unknown>)
    : [];
  return [...own, ...children.flatMap(collectChromeBookmarks), ...roots.flatMap(collectChromeBookmarks)];
}

function parseBookmarkImport(text: string): BookmarkImportCandidate[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    const candidates = collectChromeBookmarks(parsed);
    if (candidates.length > 0) return candidates;
  } catch {
    // Fall through to Netscape bookmark HTML, used by Chrome and Firefox exports.
  }

  const doc = new DOMParser().parseFromString(text, "text/html");
  return Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]")).map((anchor) => ({
    url: anchor.href,
    title: anchor.textContent?.trim() || titleForUrl(anchor.href),
  }));
}

function suggestionId(index: number): string {
  return `website-review-suggestion-${index}`;
}

export function WebsiteReviewLauncher({
  visible,
  repo,
  spacePath,
  worktree,
  target,
  onError,
  onThreadCreated,
}: Props) {
  const [url, setUrl] = useState(() => getStored(urlKey(spacePath)) ?? "");
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [reviewReady, setReviewReady] = useState(false);
  const [reviewTool, setReviewTool] = useState<ReviewTool>("browse");
  const [viewportPreset, setViewportPreset] = useState<ViewportPreset>("desktop");
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [allowedDomains, setAllowedDomains] = useState(readWebsiteAllowedDomains);
  const [history, setHistory] = useState(() => readWebsiteHistory(allowedDomains));
  const [bookmarks, setBookmarks] = useState(() => readWebsiteBookmarks(allowedDomains));
  const [urlsBySpace, setUrlsBySpace] = useState<Record<string, string>>({});
  const [websiteStateLoaded, setWebsiteStateLoaded] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [highlightedSuggestion, setHighlightedSuggestion] = useState(0);
  const [importNotice, setImportNotice] = useState<{
    message: string;
    undo: { bookmarks: WebsiteBookmark[]; allowedDomains: string[] } | null;
  } | null>(null);
  const [importingBrowsers, setImportingBrowsers] = useState(false);
  const [pendingImport, setPendingImport] = useState<BrowserBookmarkSource[] | null>(null);
  const [managerMode, setManagerMode] = useState<BookmarkManagerMode | null>(null);
  const [bookmarkSort, setBookmarkSort] = useState<WebsiteBookmarkSort>("lastUsed");
  const [bookmarkMenuOpen, setBookmarkMenuOpen] = useState(false);
  const [viewportMenuOpen, setViewportMenuOpen] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const bookmarkDetailsRef = useRef<HTMLDetailsElement>(null);
  const viewportDetailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    return () => {
      if (isDesktopShell()) void invokeDesktop<void>("close_website_review");
    };
  }, []);

  useEffect(() => {
    api
      .uiState()
      .then((state) => {
        const website = state.websiteReview;
        if (!website) return;
        const domains = website.allowedDomains === undefined
          ? readWebsiteAllowedDomains()
          : saveWebsiteAllowedDomains(website.allowedDomains);
        setAllowedDomains(domains);
        setHistory(website.history ?? readWebsiteHistory(domains));
        setBookmarks(website.bookmarks ?? readWebsiteBookmarks(domains));
        setUrlsBySpace(website.urlsBySpace ?? {});
        setUrl(website.urlsBySpace?.[spaceStateKey(spacePath)] ?? getStored(urlKey(spacePath)) ?? "");
      })
      .catch(() => {})
      .finally(() => setWebsiteStateLoaded(true));
  }, []);

  useEffect(() => {
    if (!websiteStateLoaded) return;
    void api.updateUiState({ websiteReview: { bookmarks } }).catch(() => {});
  }, [bookmarks, websiteStateLoaded]);

  useEffect(() => {
    if (!websiteStateLoaded) return;
    void api.updateUiState({ websiteReview: { history } }).catch(() => {});
  }, [history, websiteStateLoaded]);

  useEffect(() => {
    if (!websiteStateLoaded) return;
    void api.updateUiState({ websiteReview: { allowedDomains } }).catch(() => {});
  }, [allowedDomains, websiteStateLoaded]);

  useEffect(() => {
    if (!websiteStateLoaded) return;
    void api.updateUiState({ websiteReview: { urlsBySpace } }).catch(() => {});
  }, [urlsBySpace, websiteStateLoaded]);

  useEffect(() => {
    setUrl(urlsBySpace[spaceStateKey(spacePath)] ?? getStored(urlKey(spacePath)) ?? "");
    setActiveUrl(null);
    setReviewReady(false);
    setLoading(false);
    void invokeDesktop<void>("close_website_review").catch(() => {});
  }, [spacePath, websiteStateLoaded]);

  useEffect(() => {
    const update = () => setModalOpen(document.body.classList.contains("modal-open"));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  const closeBookmarkMenu = () => {
    if (bookmarkDetailsRef.current) bookmarkDetailsRef.current.open = false;
  };

  const closeViewportMenu = () => {
    if (viewportDetailsRef.current) viewportDetailsRef.current.open = false;
  };

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const details = bookmarkDetailsRef.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) {
        details.open = false;
      }
      const viewportDetails = viewportDetailsRef.current;
      if (
        viewportDetails?.open &&
        event.target instanceof Node &&
        !viewportDetails.contains(event.target)
      ) {
        viewportDetails.open = false;
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const suggestions = useMemo(
    () => websiteSuggestions(url, bookmarks, history),
    [bookmarks, history, url],
  );
  const sortedBookmarks = useMemo(
    () => sortWebsiteBookmarks(bookmarks, history, bookmarkSort),
    [bookmarkSort, bookmarks, history],
  );
  const suggestionsVisible = suggestionsOpen && suggestions.length > 0;

  useEffect(() => {
    if (highlightedSuggestion >= suggestions.length) setHighlightedSuggestion(0);
  }, [highlightedSuggestion, suggestions.length]);

  const place = useCallback(
    async (command: "open_website_review" | "position_website_review", nextUrl?: string) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const args = rectArgs(viewport);
      await invokeDesktop<void>(
        command,
        nextUrl ? { url: nextUrl, allowedDomains, ...args } : args,
      );
    },
    [allowedDomains],
  );

  const setNativeVisible = useCallback(
    (visible: boolean) => invokeDesktop<void>("set_website_review_visible", { visible }),
    [],
  );
  const nativeVisible = visible && !modalOpen && !suggestionsVisible && !bookmarkMenuOpen && !viewportMenuOpen;

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
    if (!reviewReady || nativeVisible) return;
    void setNativeVisible(false).catch(() => {});
  }, [nativeVisible, reviewReady, setNativeVisible]);

  useEffect(() => {
    if (!reviewReady) return;
    void invokeDesktop<void>("set_website_review_tool", { tool: reviewTool }).catch((error) =>
      onError(String(error)),
    );
  }, [onError, reviewReady, reviewTool]);

  useLayoutEffect(() => {
    if (!reviewReady || !nativeVisible) return;
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
  }, [nativeVisible, onError, place, reviewReady, setNativeVisible]);

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

  if (!isDesktopShell()) return null;

  const loadAddress = useCallback(
    async (rawAddress = url) => {
      const next = normalizeAddress(rawAddress);
      if (!next) return;
      setLoading(true);
      setActiveUrl(next);
      setSuggestionsOpen(false);
      try {
        setUrl(next);
        setStored(urlKey(spacePath), next);
        setUrlsBySpace((current) => ({ ...current, [spaceStateKey(spacePath)]: next }));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await place("open_website_review", next);
        setReviewReady(true);
        setHistory((current) => recordWebsiteVisit(current, next));
      } catch (error) {
        onError(String(error));
        setReviewReady(false);
        setActiveUrl(null);
        void invokeDesktop<void>("close_website_review").catch(() => {});
      } finally {
        setLoading(false);
      }
    },
    [onError, place, spacePath, url],
  );

  const chooseSuggestion = (suggestion: WebsiteSuggestion) => {
    setUrl(suggestion.url);
    setSuggestionsOpen(false);
    void loadAddress(suggestion.url);
  };

  const toggleBookmark = () => {
    const next = normalizeAddress(url);
    if (!next) return;
    setBookmarks((current) => toggleWebsiteBookmark(current, next));
  };

  // Drop candidates already bookmarked (and dupes across sources) so the
  // checklist only offers what an import would actually add.
  const withNewCandidatesOnly = (sources: BrowserBookmarkSource[]): BrowserBookmarkSource[] => {
    const seen = new Set(bookmarks.map((entry) => entry.url));
    return sources.flatMap((source) => {
      const fresh = source.bookmarks.filter((candidate) => {
        if (!isReviewableWebsiteUrl(candidate.url, allowedDomains) || seen.has(candidate.url)) return false;
        seen.add(candidate.url);
        return true;
      });
      return fresh.length > 0 ? [{ ...source, bookmarks: fresh }] : [];
    });
  };

  const openImportDialog = (
    sources: BrowserBookmarkSource[],
    emptyMessage: string,
    showEmptyDialog = false,
  ) => {
    const fresh = withNewCandidatesOnly(sources);
    if (fresh.length === 0 && !showEmptyDialog) {
      setImportNotice({ message: emptyMessage, undo: null });
      return;
    }
    setPendingImport(fresh);
  };

  const importBookmarks = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      const candidates = parseBookmarkImport(await file.text());
      openImportDialog(
        [{ browser: "Bookmarks file", profile: file.name, bookmarks: candidates }],
        "No new local bookmarks found in that file.",
      );
    } catch (error) {
      onError(String(error));
    }
  };

  const importInstalledBrowsers = async () => {
    setImportingBrowsers(true);
    try {
      const sources = await invokeDesktop<BrowserBookmarkSource[]>("import_browser_bookmarks", {
        allowedDomains,
      });
      openImportDialog(sources, "No new local bookmarks found in installed browser profiles.", true);
    } catch (error) {
      onError(String(error));
    } finally {
      setImportingBrowsers(false);
    }
  };

  const confirmImport = (candidates: BookmarkImportCandidate[]) => {
    const before = bookmarks;
    const result = mergeWebsiteBookmarks(before, candidates, allowedDomains);
    setBookmarks(result.bookmarks);
    setPendingImport(null);
    const parts = [`Imported ${result.imported} bookmark${result.imported === 1 ? "" : "s"}.`];
    if (result.truncated > 0) parts.push(`${result.truncated} over the limit.`);
    setImportNotice({ message: parts.join(" "), undo: { bookmarks: before, allowedDomains } });
  };

  const undoImport = () => {
    if (importNotice?.undo) {
      const domains = saveWebsiteAllowedDomains(importNotice.undo.allowedDomains);
      setAllowedDomains(domains);
      setHistory(readWebsiteHistory(domains));
      setBookmarks(replaceWebsiteBookmarks(importNotice.undo.bookmarks));
    }
    setImportNotice(null);
  };

  const removeBookmark = (bookmarkUrl: string) =>
    setBookmarks((current) => toggleWebsiteBookmark(current, bookmarkUrl));

  const onAddressKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && suggestions.length > 0) {
      event.preventDefault();
      setSuggestionsOpen(true);
      setHighlightedSuggestion((index) => (index + 1) % suggestions.length);
      return;
    }
    if (event.key === "ArrowUp" && suggestions.length > 0) {
      event.preventDefault();
      setSuggestionsOpen(true);
      setHighlightedSuggestion((index) => (index - 1 + suggestions.length) % suggestions.length);
      return;
    }
    if (event.key === "Enter" && suggestionsVisible) {
      const suggestion = suggestions[highlightedSuggestion];
      if (suggestion) {
        event.preventDefault();
        chooseSuggestion(suggestion);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setSuggestionsOpen(false);
    }
  };

  const normalizedUrl = normalizeAddress(url);
  const bookmarked = Boolean(normalizedUrl && bookmarks.some((entry) => entry.url === normalizedUrl));
  const isReload = activeUrl === normalizedUrl;
  const submitLabel = loading ? "Loading…" : isReload ? "Reload" : "Go";

  return (
    <section className="website-review-shell" aria-label="Website preview">
      <form
        className="website-review-addressbar"
        onSubmit={(event) => {
          event.preventDefault();
          void loadAddress();
        }}
      >
        <div className="website-review-address-field">
          <label className="sr-only" htmlFor="website-review-url">Website URL</label>
          <input
            id="website-review-url"
            type="text"
            inputMode="url"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggestionsVisible}
            aria-controls="website-review-suggestions"
            aria-activedescendant={suggestionsVisible ? suggestionId(highlightedSuggestion) : undefined}
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setSuggestionsOpen(true);
              setHighlightedSuggestion(0);
            }}
            onFocus={() => {
              setSuggestionsOpen(true);
              setHighlightedSuggestion(0);
            }}
            onBlur={() => window.setTimeout(() => setSuggestionsOpen(false), 120)}
            onKeyDown={onAddressKeyDown}
            placeholder="Search bookmarks or enter localhost:5173"
          />
          {suggestionsVisible && (
            <div className="website-review-suggestions" id="website-review-suggestions" role="listbox">
              {suggestions.map((suggestion, index) => (
                <button
                  type="button"
                  key={suggestion.url}
                  id={suggestionId(index)}
                  role="option"
                  aria-selected={index === highlightedSuggestion}
                  className={index === highlightedSuggestion ? "active" : undefined}
                  onMouseEnter={() => setHighlightedSuggestion(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseSuggestion(suggestion)}
                >
                  <span className="website-review-suggestion-title">
                    {suggestion.source === "bookmark" && <span aria-hidden="true">★ </span>}
                    {suggestion.title}
                  </span>
                  <span className="website-review-suggestion-url">{suggestion.url}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="submit"
          className="ghost website-review-submit"
          disabled={loading || !url.trim()}
          aria-label={isReload && !loading ? "Reload" : undefined}
          title={isReload && !loading ? "Reload" : undefined}
        >
          {isReload && !loading ? <Icon name="sync" size={14} /> : submitLabel}
        </button>
        <div className="open-in-menu open-in-split website-review-bookmark-menu">
          <button
            type="button"
            className={`open-in-trigger open-in-primary website-review-bookmark${bookmarked ? " active" : ""}`}
            aria-pressed={bookmarked}
            aria-label={bookmarked ? "Remove bookmark" : "Bookmark current URL"}
            title={bookmarked ? "Remove bookmark" : "Bookmark current URL"}
            disabled={!normalizedUrl}
            onClick={toggleBookmark}
          >
            ★
          </button>
          <details
            className="open-in-dropdown"
            ref={bookmarkDetailsRef}
            onToggle={(event) => setBookmarkMenuOpen(event.currentTarget.open)}
          >
            <summary
              className="open-in-trigger open-in-caret"
              title="Bookmarks"
              aria-label="Bookmarks"
            >
              <Icon name="chevron-down" size={12} />
            </summary>
            <div className="open-in-popover website-review-bookmark-popover">
              <div className="website-review-bookmark-popover-head">
                <span className="open-in-label">Bookmarks</span>
                <select
                  value={bookmarkSort}
                  aria-label="Sort bookmarks"
                  onChange={(event) => setBookmarkSort(event.target.value as WebsiteBookmarkSort)}
                >
                  <option value="lastUsed">Last used</option>
                  <option value="created">Created</option>
                </select>
              </div>
              {bookmarks.length === 0 && (
                <div className="website-review-bookmark-empty">No bookmarks yet.</div>
              )}
              {sortedBookmarks.map((bookmark) => (
                <div key={bookmark.url} className="website-review-bookmark-row">
                  <button
                    type="button"
                    className="open-in-item"
                    title={bookmark.url}
                    onClick={() => {
                      closeBookmarkMenu();
                      setUrl(bookmark.url);
                      void loadAddress(bookmark.url);
                    }}
                  >
                    <span className="website-review-bookmark-title">{bookmark.title}</span>
                    <span className="website-review-bookmark-url">{bookmark.url}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn website-review-bookmark-remove"
                    aria-label={`Remove bookmark ${bookmark.title}`}
                    title="Remove bookmark"
                    onClick={() => removeBookmark(bookmark.url)}
                  >
                    <Icon name="x" size={13} />
                  </button>
                </div>
              ))}
              <div className="open-in-divider" />
              <button
                type="button"
                className="open-in-item"
                onClick={() => {
                  closeBookmarkMenu();
                  setManagerMode("bookmarks");
                }}
              >
                <span>Manage bookmarks…</span>
              </button>
              <button
                type="button"
                className="open-in-item"
                onClick={() => {
                  closeBookmarkMenu();
                  setManagerMode("domains");
                }}
              >
                <span>Allowed domains…</span>
              </button>
              <button
                type="button"
                className="open-in-item"
                disabled={importingBrowsers}
                onClick={() => {
                  closeBookmarkMenu();
                  void importInstalledBrowsers();
                }}
              >
                <span>{importingBrowsers ? "Scanning browsers…" : "Import…"}</span>
              </button>
            </div>
          </details>
        </div>
        <input
          ref={importInputRef}
          className="sr-only"
          type="file"
          accept=".html,.htm,.json,text/html,application/json"
          tabIndex={-1}
          onChange={(event) => void importBookmarks(event)}
        />
        <span className="website-review-toolbar-divider" aria-hidden="true" />
        <details
          className="website-review-device"
          ref={viewportDetailsRef}
          onToggle={(event) => setViewportMenuOpen(event.currentTarget.open)}
        >
          <summary aria-label="Preview size" title="Preview size">
            <Icon name={VIEWPORT_PRESETS[viewportPreset].icon} size={15} />
            <span>{VIEWPORT_PRESETS[viewportPreset].label}</span>
            <Icon name="chevron-down" size={12} />
          </summary>
          <div className="open-in-popover website-review-device-popover">
            <div className="open-in-label">Preview size</div>
            {(Object.keys(VIEWPORT_PRESETS) as ViewportPreset[]).map((preset) => {
              const option = VIEWPORT_PRESETS[preset];
              return (
                <button
                  key={preset}
                  type="button"
                  className={`open-in-item ${preset === viewportPreset ? "active" : ""}`}
                  onClick={() => {
                    setViewportPreset(preset);
                    closeViewportMenu();
                  }}
                >
                  <Icon name={option.icon} size={16} />
                  <span>{option.label}</span>
                  {preset === viewportPreset && <Icon name="check" size={13} className="open-in-check" />}
                </button>
              );
            })}
          </div>
        </details>
        <div className="website-review-tool-group" aria-label="Preview tools">
          {REVIEW_TOOL_ORDER.map((tool) => {
            const option = REVIEW_TOOLS[tool];
            return (
              <button
                key={tool}
                type="button"
                className={`website-review-tool${reviewTool === tool ? " active" : ""}`}
                aria-label={option.label}
                aria-pressed={reviewTool === tool}
                disabled={!reviewReady}
                onClick={() => changeTool(tool)}
                title={option.title}
              >
                <Icon name={option.icon} size={15} />
                <span className="sr-only">{option.label}</span>
              </button>
            );
          })}
        </div>
      </form>
      {importNotice && (
        <div className="website-review-import-message" role="status">
          <span>{importNotice.message}</span>
          {importNotice.undo && (
            <button type="button" className="ghost" onClick={undoImport}>
              Undo
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label="Dismiss"
            onClick={() => setImportNotice(null)}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
      {pendingImport && (
        <ImportBookmarksDialog
          sources={pendingImport}
          allowedDomains={allowedDomains}
          onCancel={() => setPendingImport(null)}
          onImport={confirmImport}
          onChooseFile={() => importInputRef.current?.click()}
        />
      )}
      {managerMode && (
        <ManageBookmarksDialog
          mode={managerMode}
          bookmarks={sortedBookmarks}
          allowedDomains={allowedDomains}
          onClose={() => setManagerMode(null)}
          onSave={(nextBookmarks, nextDomains) => {
            const before = { bookmarks, allowedDomains };
            setBookmarks(replaceWebsiteBookmarks(nextBookmarks));
            const domains = saveWebsiteAllowedDomains(nextDomains);
            setAllowedDomains(domains);
            setHistory(readWebsiteHistory(domains));
            setImportNotice({ message: "Saved bookmark settings.", undo: before });
            setManagerMode(null);
          }}
        />
      )}
      {activeUrl ? (
        <div
          ref={viewportRef}
          className={`website-review-viewport website-review-viewport-${viewportPreset}`}
        />
      ) : (
        <div className="website-review-empty">
          Enter a localhost URL to load a web preview.
        </div>
      )}
    </section>
  );
}

interface ImportBookmarksDialogProps {
  sources: BrowserBookmarkSource[];
  allowedDomains: string[];
  onCancel: () => void;
  onImport: (bookmarks: BookmarkImportCandidate[]) => void;
  onChooseFile: () => void;
}

function ImportBookmarksDialog({
  sources,
  allowedDomains,
  onCancel,
  onImport,
  onChooseFile,
}: ImportBookmarksDialogProps) {
  const allUrls = sources.flatMap((source) => source.bookmarks.map((bookmark) => bookmark.url));
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allUrls));
  const selectedCount = selected.size;

  const toggleUrl = (url: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };
  const toggleSource = (source: BrowserBookmarkSource) => {
    const urls = source.bookmarks.map((bookmark) => bookmark.url);
    const allSelected = urls.every((url) => selected.has(url));
    setSelected((current) => {
      const next = new Set(current);
      for (const url of urls) {
        if (allSelected) next.delete(url);
        else next.add(url);
      }
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(allUrls));
  const selectNone = () => setSelected(new Set());
  const allBookmarks = sources.flatMap((source) => source.bookmarks);
  const confirmSelected = () => {
    onImport(allBookmarks.filter((bookmark) => selected.has(bookmark.url)));
  };
  const confirmAll = () => onImport(allBookmarks);

  return (
    <Modal title="Import bookmarks" onClose={onCancel}>
      <div className="website-review-import-dialog">
        <p className="website-review-import-intro">
          Review the detected browser profiles and choose which bookmarks to import.
          {allowedDomains.length > 0
            ? ` Allowed domains: ${allowedDomains.join(", ")}.`
            : " Only loopback URLs are included until you add allowed domains."}
        </p>
        <div className="website-review-import-actions">
          <button type="button" className="ghost" onClick={selectAll}>Select all</button>
          <button type="button" className="ghost" onClick={selectNone}>Select none</button>
          <span>{selectedCount} selected</span>
        </div>
        <div className="website-review-import-list">
          {sources.length === 0 && (
            <div className="website-review-import-empty">
              No new bookmarks were found from installed browsers. You can add allowed domains or import from an exported bookmark file.
            </div>
          )}
          {sources.map((source) => {
            const sourceUrls = source.bookmarks.map((bookmark) => bookmark.url);
            const sourceSelected = sourceUrls.filter((url) => selected.has(url)).length;
            const sourceChecked = sourceSelected === sourceUrls.length;
            return (
              <section key={`${source.browser}:${source.profile}`} className="website-review-import-source">
                <label className="website-review-import-source-head">
                  <input
                    type="checkbox"
                    checked={sourceChecked}
                    ref={(input) => {
                      if (input) input.indeterminate = sourceSelected > 0 && !sourceChecked;
                    }}
                    onChange={() => toggleSource(source)}
                  />
                  <span>
                    <strong>{source.browser}</strong>
                    <span>{source.profile}</span>
                  </span>
                  <em>{source.bookmarks.length} bookmarks</em>
                </label>
                <div className="website-review-import-bookmarks">
                  {source.bookmarks.map((bookmark) => (
                    <label key={bookmark.url} className="website-review-import-bookmark">
                      <input
                        type="checkbox"
                        checked={selected.has(bookmark.url)}
                        onChange={() => toggleUrl(bookmark.url)}
                      />
                      <span>
                        <strong>{bookmark.title}</strong>
                        <code>{bookmark.url}</code>
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
        <div className="website-review-import-footer">
          <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="ghost" onClick={onChooseFile}>Import from file…</button>
          <button type="button" className="ghost" disabled={allBookmarks.length === 0} onClick={confirmAll}>
            Import all
          </button>
          <button type="button" className="primary" disabled={selectedCount === 0} onClick={confirmSelected}>
            Import selected
          </button>
        </div>
      </div>
    </Modal>
  );
}

interface ManageBookmarksDialogProps {
  mode: BookmarkManagerMode;
  bookmarks: WebsiteBookmark[];
  allowedDomains: string[];
  onClose: () => void;
  onSave: (bookmarks: WebsiteBookmark[], allowedDomains: string[]) => void;
}

function ManageBookmarksDialog({
  mode,
  bookmarks,
  allowedDomains,
  onClose,
  onSave,
}: ManageBookmarksDialogProps) {
  const [draftBookmarks, setDraftBookmarks] = useState(() => bookmarks);
  const [domainsText, setDomainsText] = useState(() => allowedDomains.join("\n"));
  const [tab, setTab] = useState<BookmarkManagerMode>(mode);

  const updateBookmark = (index: number, patch: Partial<WebsiteBookmark>) => {
    setDraftBookmarks((current) =>
      current.map((bookmark, i) => (i === index ? { ...bookmark, ...patch } : bookmark)),
    );
  };
  const removeDraftBookmark = (index: number) => {
    setDraftBookmarks((current) => current.filter((_, i) => i !== index));
  };
  const save = () => {
    const nextDomains = saveWebsiteAllowedDomains(domainsText.split(/\s|,/));
    const nextBookmarks = draftBookmarks.filter((bookmark) =>
      bookmark.url.trim() && isReviewableWebsiteUrl(bookmark.url, nextDomains),
    );
    onSave(nextBookmarks, nextDomains);
  };

  return (
    <Modal title="Manage website bookmarks" onClose={onClose}>
      <div className="website-review-manage-dialog">
        <div className="pane-tabs website-review-manage-tabs" role="tablist" aria-label="Bookmark settings">
          <button
            type="button"
            className={`pane-tab${tab === "bookmarks" ? " active" : ""}`}
            role="tab"
            aria-selected={tab === "bookmarks"}
            onClick={() => setTab("bookmarks")}
          >
            Bookmarks
          </button>
          <button
            type="button"
            className={`pane-tab${tab === "domains" ? " active" : ""}`}
            role="tab"
            aria-selected={tab === "domains"}
            onClick={() => setTab("domains")}
          >
            Allowed domains
          </button>
        </div>
        {tab === "bookmarks" ? (
          <div className="website-review-manage-list">
            {draftBookmarks.length === 0 && <div className="muted">No bookmarks yet.</div>}
            {draftBookmarks.map((bookmark, index) => (
              <div key={`${bookmark.url}:${index}`} className="website-review-manage-bookmark">
                <label>
                  Title
                  <input
                    value={bookmark.title}
                    onChange={(event) => updateBookmark(index, { title: event.target.value })}
                  />
                </label>
                <label>
                  URL
                  <input
                    value={bookmark.url}
                    onChange={(event) => updateBookmark(index, { url: event.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="ghost danger"
                  onClick={() => removeDraftBookmark(index)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="website-review-domain-settings">
            <p>
              Browser import and the embedded preview always allow localhost. Add one domain per line for work apps you want to import and open, such as <code>odeko.com</code> or <code>netsuite.com</code>.
            </p>
            <textarea
              value={domainsText}
              rows={8}
              onChange={(event) => setDomainsText(event.target.value)}
              placeholder={"odeko.com\nnetsuite.com"}
            />
          </div>
        )}
        <div className="website-review-import-footer">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" onClick={save}>Save changes</button>
        </div>
      </div>
    </Modal>
  );
}
