// Shared contracts for the clean Review runtime.

import type { ReviewDetail } from "./reviews.js";
export * from "./reviews.js";

export const DAEMON_EVENTS = {
  diffChanged: "diff.changed",
  workspaceChanged: "workspace.changed",
} as const;
export type DaemonEventType = (typeof DAEMON_EVENTS)[keyof typeof DAEMON_EVENTS];

export interface DaemonEventPayload {
  repo?: string;
  worktree?: string | null;
  path?: string | null;
}

export type DiffLineType = "context" | "add" | "del";

export interface DiffLine {
  type: DiffLineType;
  old: number | null;
  new: number | null;
  text: string;
  noNewline?: boolean;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked";

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  ignored?: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface RepoDiff {
  repo?: string;
  worktree?: string | null;
  target: "work";
  files: DiffFile[];
}

export interface FileContent {
  old: string | null;
  new: string | null;
}

export interface ReviewDiffFile extends DiffFile, FileContent {}

export interface ReviewDiff extends Omit<RepoDiff, "files"> {
  files: ReviewDiffFile[];
}

export interface WorkspaceWorktree {
  name: string;
  root: string;
  branch: string | null;
}

export interface WorkspaceRepository {
  name: string;
  root: string;
  worktrees: WorkspaceWorktree[];
}

export interface WorkspaceSummary {
  root: string;
  repos: WorkspaceRepository[];
}

export interface CurrentChangesResponse {
  repository: WorkspaceRepository;
  worktree: WorkspaceWorktree;
  review: ReviewDetail | null;
  diff: ReviewDiff;
}

export interface WorkspaceMutationRequest {
  path: string;
}

/** Local, reviewable PR draft packet. This is not a GitHub draft PR object. */
export interface PrDraft {
  workspacePath: string;
  repo: string;
  worktree: string | null;
  branch: string | null;
  title: string;
  body: string;
  updatedAt: string | null;
}

export interface PrDraftUpdateRequest {
  title?: string;
  body?: string;
}
