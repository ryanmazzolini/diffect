import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { UiReviewSelection, UiState, UiStateUpdate } from "@diffect/shared";
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
    const next: UiState = {
      workspaceRecency: { ...current.workspaceRecency, ...cleanRecency(patch.workspaceRecency) },
      reviewRecency: mergeReviewRecency(current.reviewRecency, patch.reviewRecency),
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
  return {
    workspaceRecency,
    reviewRecency: mergeReviewRecency(
      legacyReviewRecency((raw as { workspacePlaces?: unknown }).workspacePlaces, workspaceRecency),
      raw.reviewRecency,
    ),
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

function cleanReview(value: unknown): UiReviewSelection | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<UiReviewSelection>;
  if (typeof raw.target !== "string") return null;
  return {
    worktree: typeof raw.worktree === "string" ? raw.worktree : null,
    target: raw.target,
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
