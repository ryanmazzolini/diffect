import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PrDraft, PrDraftUpdateRequest } from "@diffect/shared";
import { repoStoreDir } from "./paths.js";

const VERSION = 1;

export interface PrDraftScope {
  workspacePath: string;
  repo: string;
  repoRoot: string;
  worktree: string | null;
  branch: string | null;
}

interface StoredDraft {
  title: string;
  body: string;
  updatedAt: string;
}

interface StoredPrDrafts {
  v: typeof VERSION;
  drafts: Record<string, StoredDraft>;
}

function prDraftPath(repoRoot: string): string {
  return join(repoStoreDir(repoRoot), "pr-drafts.json");
}

function draftKey(scope: PrDraftScope): string {
  return scope.branch ? `branch:${scope.branch}` : `worktree:${scope.worktree ?? "primary"}`;
}

function emptyPrDraft(scope: PrDraftScope): PrDraft {
  return {
    workspacePath: scope.workspacePath,
    repo: scope.repo,
    worktree: scope.worktree,
    branch: scope.branch,
    title: "",
    body: "",
    updatedAt: null,
  };
}

function fromStored(scope: PrDraftScope, stored: StoredDraft): PrDraft {
  return {
    workspacePath: scope.workspacePath,
    repo: scope.repo,
    worktree: scope.worktree,
    branch: scope.branch,
    title: stored.title,
    body: stored.body,
    updatedAt: stored.updatedAt,
  };
}

function validDraft(value: unknown): value is StoredDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<StoredDraft>;
  return (
    typeof draft.title === "string" &&
    typeof draft.body === "string" &&
    typeof draft.updatedAt === "string"
  );
}

async function readStore(repoRoot: string): Promise<StoredPrDrafts> {
  try {
    const parsed = JSON.parse(await readFile(prDraftPath(repoRoot), "utf8")) as Partial<StoredPrDrafts>;
    if (parsed.v !== VERSION || !parsed.drafts || typeof parsed.drafts !== "object") {
      return { v: VERSION, drafts: {} };
    }
    const drafts: Record<string, StoredDraft> = {};
    for (const [key, draft] of Object.entries(parsed.drafts)) {
      if (validDraft(draft)) drafts[key] = draft;
    }
    return { v: VERSION, drafts };
  } catch {
    return { v: VERSION, drafts: {} };
  }
}

export async function readPrDraft(scope: PrDraftScope): Promise<PrDraft> {
  const draft = (await readStore(scope.repoRoot)).drafts[draftKey(scope)];
  return draft ? fromStored(scope, draft) : emptyPrDraft(scope);
}

export async function updatePrDraft(
  scope: PrDraftScope,
  patch: PrDraftUpdateRequest,
  updatedAt: string,
): Promise<PrDraft> {
  const store = await readStore(scope.repoRoot);
  const key = draftKey(scope);
  const current = store.drafts[key] ?? { title: "", body: "", updatedAt };
  const next: StoredDraft = {
    title: patch.title ?? current.title,
    body: patch.body ?? current.body,
    updatedAt,
  };
  const file = prDraftPath(scope.repoRoot);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify({ v: VERSION, drafts: { ...store.drafts, [key]: next } }, null, 2) + "\n",
    "utf8",
  );
  await rename(tmp, file);
  return fromStored(scope, next);
}
