import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ReviewTargetPresentation,
  UiReviewSelection,
  UiState,
  UiStateUpdate,
  WebsiteReviewUiState,
} from "@diffect/shared";
import { uiStatePath } from "./paths.js";

const EMPTY_UI_STATE: UiState = { workspaceRecency: {}, reviewRecency: {} };

let updateChain: Promise<unknown> = Promise.resolve();
let tmpCounter = 0;

export async function readUiState(): Promise<UiState> {
  try {
    return parseUiState(JSON.parse(await readFile(uiStatePath(), "utf8")));
  } catch {
    return EMPTY_UI_STATE;
  }
}

export function updateUiState(patch: UiStateUpdate): Promise<UiState> {
  const run = async () => {
    const current = await readUiState();
    const websiteReview = mergeWebsiteReview(current.websiteReview, patch.websiteReview);
    const next: UiState = {
      workspaceRecency: { ...current.workspaceRecency, ...cleanRecency(patch.workspaceRecency) },
      reviewRecency: mergeReviewRecency(current.reviewRecency, patch.reviewRecency),
      ...(websiteReview ? { websiteReview } : {}),
    };
    await writeUiState(next);
    return next;
  };
  const next = updateChain.then(run, run);
  updateChain = next.catch(() => {});
  return next;
}

async function writeUiState(state: UiState): Promise<void> {
  const file = uiStatePath();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${++tmpCounter}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

function parseUiState(value: unknown): UiState {
  if (!value || typeof value !== "object") return EMPTY_UI_STATE;
  const raw = value as Partial<UiState>;
  const workspaceRecency = cleanRecency(raw.workspaceRecency);
  const websiteReview = cleanWebsiteReview(raw.websiteReview);
  return {
    workspaceRecency,
    reviewRecency: mergeReviewRecency(
      legacyReviewRecency((raw as { workspacePlaces?: unknown }).workspacePlaces, workspaceRecency),
      raw.reviewRecency,
    ),
    ...(websiteReview ? { websiteReview } : {}),
  };
}

function cleanRecency(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [path, ts] of Object.entries(value)) {
    if (typeof ts === "number" && Number.isFinite(ts)) out[path] = ts;
  }
  return out;
}

function cleanWebsiteReview(value: unknown): WebsiteReviewUiState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<WebsiteReviewUiState>;
  const clean: WebsiteReviewUiState = {};
  if (Array.isArray(raw.bookmarks)) {
    clean.bookmarks = raw.bookmarks.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as Record<string, unknown>;
      if (typeof item.url !== "string" || typeof item.title !== "string") return [];
      return [{
        url: item.url,
        title: item.title,
        addedAt: typeof item.addedAt === "number" && Number.isFinite(item.addedAt) ? item.addedAt : 0,
      }];
    });
  }
  if (Array.isArray(raw.history)) {
    clean.history = raw.history.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as Record<string, unknown>;
      if (typeof item.url !== "string" || typeof item.title !== "string") return [];
      return [{
        url: item.url,
        title: item.title,
        lastVisitedAt: typeof item.lastVisitedAt === "number" && Number.isFinite(item.lastVisitedAt) ? item.lastVisitedAt : 0,
        visitCount: typeof item.visitCount === "number" && Number.isFinite(item.visitCount) ? item.visitCount : 1,
      }];
    });
  }
  if (Array.isArray(raw.allowedDomains)) {
    clean.allowedDomains = raw.allowedDomains.filter(
      (domain): domain is string => typeof domain === "string",
    );
  }
  if (raw.urlsBySpace && typeof raw.urlsBySpace === "object") {
    clean.urlsBySpace = Object.fromEntries(
      Object.entries(raw.urlsBySpace).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

function mergeWebsiteReview(
  current: WebsiteReviewUiState | undefined,
  patch: unknown,
): WebsiteReviewUiState | undefined {
  if (patch === undefined) return current;
  const clean = cleanWebsiteReview(patch);
  if (!clean) return current;
  return {
    ...current,
    ...clean,
    ...(clean.urlsBySpace === undefined
      ? {}
      : { urlsBySpace: { ...(current?.urlsBySpace ?? {}), ...clean.urlsBySpace } }),
  };
}

function cleanReviewPresentation(value: unknown): ReviewTargetPresentation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw.kind === "compare" &&
    typeof raw.baseRef === "string" &&
    typeof raw.baseLabel === "string" &&
    typeof raw.compareRef === "string" &&
    typeof raw.compareLabel === "string"
  ) {
    return {
      kind: "compare",
      baseRef: raw.baseRef,
      baseLabel: raw.baseLabel,
      ...(raw.baseIsRepoStart === true ? { baseIsRepoStart: true } : {}),
      compareRef: raw.compareRef,
      compareLabel: raw.compareLabel,
    };
  }
  return undefined;
}

function cleanReview(value: unknown): UiReviewSelection | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<UiReviewSelection>;
  if (typeof raw.target !== "string") return null;
  const presentation = cleanReviewPresentation(raw.presentation);
  return {
    worktree: typeof raw.worktree === "string" ? raw.worktree : null,
    target: raw.target,
    ...(presentation ? { presentation } : {}),
    openedAt: typeof raw.openedAt === "number" && Number.isFinite(raw.openedAt) ? raw.openedAt : 0,
  };
}

function cleanReviewRecency(value: unknown): Record<string, Record<string, UiReviewSelection>> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, Record<string, UiReviewSelection>> = {};
  for (const [workspacePath, reviews] of Object.entries(value)) {
    if (!reviews || typeof reviews !== "object") continue;
    const byRepo: Record<string, UiReviewSelection> = {};
    for (const [repo, review] of Object.entries(reviews)) {
      const parsed = cleanReview(review);
      if (parsed) byRepo[repo] = parsed;
    }
    if (Object.keys(byRepo).length > 0) out[workspacePath] = byRepo;
  }
  return out;
}

function legacyReviewRecency(
  value: unknown,
  workspaceRecency: Record<string, number>,
): Record<string, Record<string, UiReviewSelection>> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, Record<string, UiReviewSelection>> = {};
  for (const [workspacePath, place] of Object.entries(value)) {
    if (!place || typeof place !== "object") continue;
    const raw = place as { selections?: unknown };
    if (!raw.selections || typeof raw.selections !== "object") continue;
    const byRepo: Record<string, UiReviewSelection> = {};
    for (const [repo, sel] of Object.entries(raw.selections)) {
      if (!sel || typeof sel !== "object") continue;
      const review = sel as { worktree?: unknown; target?: unknown };
      if (typeof review.target !== "string") continue;
      byRepo[repo] = {
        worktree: typeof review.worktree === "string" ? review.worktree : null,
        target: review.target,
        openedAt: workspaceRecency[workspacePath] ?? 0,
      };
    }
    if (Object.keys(byRepo).length > 0) out[workspacePath] = byRepo;
  }
  return out;
}

function mergeReviewRecency(
  current: Record<string, Record<string, UiReviewSelection>>,
  patch: unknown,
): Record<string, Record<string, UiReviewSelection>> {
  const clean = cleanReviewRecency(patch);
  const next: Record<string, Record<string, UiReviewSelection>> = { ...current };
  for (const [workspacePath, reviews] of Object.entries(clean)) {
    next[workspacePath] = { ...(next[workspacePath] ?? {}), ...reviews };
  }
  return next;
}
