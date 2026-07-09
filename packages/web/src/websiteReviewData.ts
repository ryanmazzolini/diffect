import { getStored, setStored } from "./storage.js";

const HISTORY_KEY = "diffect-website-review-history";
const BOOKMARKS_KEY = "diffect-website-review-bookmarks";
const ALLOWED_DOMAINS_KEY = "diffect-website-review-allowed-domains";
const MAX_HISTORY = 100;
const MAX_BOOKMARKS = 1000;

export interface WebsiteHistoryEntry {
  url: string;
  title: string;
  lastVisitedAt: number;
  visitCount: number;
}

export interface WebsiteBookmark {
  url: string;
  title: string;
  addedAt: number;
}

export type WebsiteBookmarkSort = "created" | "lastUsed";

export interface WebsiteSuggestion {
  url: string;
  title: string;
  source: "bookmark" | "history";
  lastVisitedAt?: number;
  visitCount?: number;
}

export interface BookmarkImportCandidate {
  url: string;
  title: string;
}

export interface BookmarkImportResult {
  bookmarks: WebsiteBookmark[];
  imported: number;
  skipped: number;
  truncated: number;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object";
}

function storedArray(key: string): unknown[] {
  const raw = getStored(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stringField(record: UnknownRecord, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function numberField(record: UnknownRecord, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function saveHistory(entries: WebsiteHistoryEntry[]): void {
  setStored(HISTORY_KEY, JSON.stringify(entries));
}

function saveBookmarks(entries: WebsiteBookmark[]): void {
  setStored(BOOKMARKS_KEY, JSON.stringify(entries));
}

function normalizeDomain(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return /^[a-z0-9.-]+$/.test(trimmed) ? trimmed : null;
  }
}

export function readWebsiteAllowedDomains(): string[] {
  return storedArray(ALLOWED_DOMAINS_KEY).flatMap((value) => {
    if (typeof value !== "string") return [];
    const domain = normalizeDomain(value);
    return domain ? [domain] : [];
  });
}

export function saveWebsiteAllowedDomains(domains: string[]): string[] {
  const seen = new Set<string>();
  const next = domains.flatMap((value) => {
    const domain = normalizeDomain(value);
    if (!domain || seen.has(domain)) return [];
    seen.add(domain);
    return [domain];
  });
  setStored(ALLOWED_DOMAINS_KEY, JSON.stringify(next));
  return next;
}

export function titleForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

export function domainAllowedForWebsiteUrl(url: string, allowedDomains: string[]): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export function isReviewableWebsiteUrl(url: string, allowedDomains: string[] = []): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname.startsWith("127.") ||
      hostname === "[::1]" ||
      hostname === "::1" ||
      domainAllowedForWebsiteUrl(url, allowedDomains)
    );
  } catch {
    return false;
  }
}

export function sortWebsiteBookmarks(
  bookmarks: WebsiteBookmark[],
  history: WebsiteHistoryEntry[],
  sort: WebsiteBookmarkSort,
): WebsiteBookmark[] {
  const lastUsed = new Map(history.map((entry) => [entry.url, entry.lastVisitedAt]));
  return [...bookmarks].sort((a, b) => {
    if (sort === "lastUsed") {
      return (lastUsed.get(b.url) ?? 0) - (lastUsed.get(a.url) ?? 0) || b.addedAt - a.addedAt;
    }
    return b.addedAt - a.addedAt;
  });
}

export function readWebsiteHistory(allowedDomains = readWebsiteAllowedDomains()): WebsiteHistoryEntry[] {
  return storedArray(HISTORY_KEY).flatMap((value) => {
    if (!isRecord(value)) return [];
    const url = stringField(value, "url").trim();
    if (!url || !isReviewableWebsiteUrl(url, allowedDomains)) return [];
    return [{
      url,
      title: stringField(value, "title").trim() || titleForUrl(url),
      lastVisitedAt: numberField(value, "lastVisitedAt"),
      visitCount: Math.max(1, numberField(value, "visitCount")),
    }];
  });
}

export function readWebsiteBookmarks(allowedDomains = readWebsiteAllowedDomains()): WebsiteBookmark[] {
  return storedArray(BOOKMARKS_KEY).flatMap((value) => {
    if (!isRecord(value)) return [];
    const url = stringField(value, "url").trim();
    if (!url || !isReviewableWebsiteUrl(url, allowedDomains)) return [];
    return [{
      url,
      title: stringField(value, "title").trim() || titleForUrl(url),
      addedAt: numberField(value, "addedAt"),
    }];
  });
}

export function recordWebsiteVisit(
  current: WebsiteHistoryEntry[],
  url: string,
  title = titleForUrl(url),
): WebsiteHistoryEntry[] {
  const now = Date.now();
  const withoutUrl = current.filter((entry) => entry.url !== url);
  const existing = current.find((entry) => entry.url === url);
  const next = [{
    url,
    title: title.trim() || titleForUrl(url),
    lastVisitedAt: now,
    visitCount: (existing?.visitCount ?? 0) + 1,
  }, ...withoutUrl].slice(0, MAX_HISTORY);
  saveHistory(next);
  return next;
}

export function toggleWebsiteBookmark(
  current: WebsiteBookmark[],
  url: string,
  title = titleForUrl(url),
): WebsiteBookmark[] {
  if (current.some((entry) => entry.url === url)) {
    const next = current.filter((entry) => entry.url !== url);
    saveBookmarks(next);
    return next;
  }
  const next = [{ url, title: title.trim() || titleForUrl(url), addedAt: Date.now() }, ...current]
    .slice(0, MAX_BOOKMARKS);
  saveBookmarks(next);
  return next;
}

export function replaceWebsiteBookmarks(bookmarks: WebsiteBookmark[]): WebsiteBookmark[] {
  saveBookmarks(bookmarks);
  return bookmarks;
}

export function mergeWebsiteBookmarks(
  current: WebsiteBookmark[],
  candidates: BookmarkImportCandidate[],
  allowedDomains = readWebsiteAllowedDomains(),
): BookmarkImportResult {
  const existingUrls = new Set(current.map((entry) => entry.url));
  const next = [...current];
  let imported = 0;
  let skipped = 0;
  let truncated = 0;
  for (const candidate of candidates) {
    const url = candidate.url.trim();
    if (!url || !isReviewableWebsiteUrl(url, allowedDomains) || existingUrls.has(url)) {
      skipped += 1;
      continue;
    }
    if (next.length >= MAX_BOOKMARKS) {
      truncated += 1;
      continue;
    }
    existingUrls.add(url);
    next.push({
      url,
      title: candidate.title.trim() || titleForUrl(url),
      addedAt: Date.now(),
    });
    imported += 1;
  }
  saveBookmarks(next);
  return { bookmarks: next, imported, skipped, truncated };
}

export function websiteSuggestions(
  query: string,
  bookmarks: WebsiteBookmark[],
  history: WebsiteHistoryEntry[],
): WebsiteSuggestion[] {
  const normalized = query.trim().toLowerCase();
  const seen = new Set<string>();
  const candidates: WebsiteSuggestion[] = [];
  const matches = (title: string, url: string) => {
    if (!normalized) return true;
    return title.toLowerCase().includes(normalized) || url.toLowerCase().includes(normalized);
  };

  for (const bookmark of bookmarks) {
    if (!matches(bookmark.title, bookmark.url)) continue;
    seen.add(bookmark.url);
    const visit = history.find((entry) => entry.url === bookmark.url);
    candidates.push({
      url: bookmark.url,
      title: bookmark.title,
      source: "bookmark",
      lastVisitedAt: visit?.lastVisitedAt,
      visitCount: visit?.visitCount,
    });
  }

  for (const entry of history) {
    if (seen.has(entry.url) || !matches(entry.title, entry.url)) continue;
    seen.add(entry.url);
    candidates.push({
      url: entry.url,
      title: entry.title,
      source: "history",
      lastVisitedAt: entry.lastVisitedAt,
      visitCount: entry.visitCount,
    });
  }

  return candidates.slice(0, 8);
}
