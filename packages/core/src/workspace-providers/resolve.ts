import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type {
  DiffectSettings,
  SettingsValidationIssue,
  WorkspaceProviderConfig,
  WorkspaceProviderResult,
  WorkspaceResolutionCandidate,
  WorkspaceResolutionRequest,
  WorkspaceResolutionResponse,
} from "@diffect/shared";
import { gitTry } from "../git/exec.js";
import { realpathSafe } from "../path-safe.js";
import { discoverWorkspace, type Workspace } from "../workspace.js";
import { discoverClaudeSessionWorkspaces } from "./claude-session.js";
import { discoverCmuxWorkspaces } from "./cmux.js";
import { discoverCwdWorkspace } from "./cwd.js";
import { discoverHerdrWorkspaces } from "./herdr.js";
import { discoverPiSessionWorkspaces } from "./pi-session.js";
import type { WorkspaceProviderContext } from "./types.js";

const MAX_RESOLUTION_CANDIDATES = 20;

interface RankedCandidate {
  candidate: WorkspaceResolutionCandidate;
  bound: boolean;
}

export class WorkspaceResolutionError extends Error {
  constructor(readonly issues: SettingsValidationIssue[]) {
    super("workspace resolution request is invalid");
    this.name = "WorkspaceResolutionError";
  }
}

export function parseWorkspaceResolutionRequest(
  value: unknown,
): WorkspaceResolutionRequest {
  const issues: SettingsValidationIssue[] = [];
  const raw = objectValue(value, "$", issues);
  if (!raw) throw new WorkspaceResolutionError(issues);
  unknownKeys(raw, ["explicitWorkspace", "cwd", "agentSession"], "", issues);

  const explicitWorkspace = optionalAbsolutePath(
    raw.explicitWorkspace,
    "explicitWorkspace",
    issues,
  );
  const cwd = optionalAbsolutePath(raw.cwd, "cwd", issues);
  const sessionRaw = raw.agentSession === undefined
    ? undefined
    : objectValue(raw.agentSession, "agentSession", issues);
  let agentSession: WorkspaceResolutionRequest["agentSession"];
  if (sessionRaw) {
    unknownKeys(sessionRaw, ["provider", "id", "path", "cwd"], "agentSession", issues);
    const provider = sessionRaw.provider;
    if (provider !== "pi" && provider !== "claude") {
      issue(issues, "agentSession.provider", "must be pi or claude");
    }
    const id = optionalNonEmptyString(sessionRaw.id, "agentSession.id", issues);
    const path = optionalAbsolutePath(sessionRaw.path, "agentSession.path", issues);
    const sessionCwd = optionalAbsolutePath(sessionRaw.cwd, "agentSession.cwd", issues);
    if (
      (provider === "pi" || provider === "claude") &&
      id !== null &&
      path !== null &&
      sessionCwd !== null
    ) {
      agentSession = {
        provider,
        ...(id === undefined ? {} : { id }),
        ...(path === undefined ? {} : { path }),
        ...(sessionCwd === undefined ? {} : { cwd: sessionCwd }),
      };
    }
  }

  if (issues.length > 0) throw new WorkspaceResolutionError(issues);
  return {
    ...(typeof explicitWorkspace === "string" ? { explicitWorkspace } : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
    ...(agentSession === undefined ? {} : { agentSession }),
  };
}

export async function resolveWorkspace(
  request: WorkspaceResolutionRequest,
  settings: DiffectSettings,
): Promise<WorkspaceResolutionResponse> {
  if (request.explicitWorkspace) {
    const explicit = await validateExplicitPath(request.explicitWorkspace);
    if (!explicit) {
      throw new WorkspaceResolutionError([
        {
          path: "explicitWorkspace",
          message: "must contain a Git repository or Diffect workspace",
        },
      ]);
    }
    const selected: WorkspaceResolutionCandidate = {
      workspacePath: explicit.workspacePath,
      anchorPath: explicit.anchorPath,
      providerId: null,
      label: basename(explicit.workspacePath),
      matchedSession: false,
    };
    return { selected, candidates: [selected], results: [] };
  }

  const context: WorkspaceProviderContext = {
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.agentSession === undefined ? {} : { agentSession: request.agentSession }),
  };
  const results: WorkspaceProviderResult[] = [];

  for (const provider of settings.workspaceResolution.providers) {
    if (!provider.enabled) continue;
    const observed = await observeProvider(provider, context).catch(
      (error): WorkspaceProviderResult[] => [
        {
          providerId: provider.id,
          candidatePaths: [],
          matchedSession: false,
          status: "error",
          message: error instanceof Error ? error.message : "provider failed",
        },
      ],
    );
    const ranked: RankedCandidate[] = [];
    for (const result of observed) {
      const resolved = await candidatesForResult(
        result,
        settings.workspaceResolution.bindings,
      );
      results.push(resolved.result);
      ranked.push(...resolved.candidates);
    }

    const unique = dedupeRankedCandidates(ranked);
    if (unique.length === 0) continue;
    const bound = unique.filter((item) => item.bound);
    const matched = unique.filter((item) => item.candidate.matchedSession);
    const preferred = bound.length > 0 ? bound : matched.length > 0 ? matched : unique;
    const candidates = preferred
      .slice(0, MAX_RESOLUTION_CANDIDATES)
      .map((item) => item.candidate);
    return {
      selected: candidates.length === 1 ? candidates[0]! : null,
      candidates,
      results,
    };
  }

  return { selected: null, candidates: [], results };
}

async function observeProvider(
  provider: WorkspaceProviderConfig,
  context: WorkspaceProviderContext,
): Promise<WorkspaceProviderResult[]> {
  if (provider.kind === "herdr") {
    return discoverHerdrWorkspaces(provider, context);
  }
  if (provider.kind === "cmux") {
    return discoverCmuxWorkspaces(provider, context);
  }
  if (provider.kind === "pi-session") {
    return discoverPiSessionWorkspaces(provider, context);
  }
  if (provider.kind === "claude-session") {
    return discoverClaudeSessionWorkspaces(provider, context);
  }
  return discoverCwdWorkspace(provider, context);
}

async function candidatesForResult(
  result: WorkspaceProviderResult,
  bindings: DiffectSettings["workspaceResolution"]["bindings"],
): Promise<{ result: WorkspaceProviderResult; candidates: RankedCandidate[] }> {
  if (result.status !== "available") return { result, candidates: [] };
  const contextCandidates = (
    await Promise.all(result.candidatePaths.map(validateContextPath))
  ).filter((candidate): candidate is ValidatedPath => candidate !== null);
  const binding = result.externalWorkspaceId
    ? bindings.find(
        (candidate) =>
          candidate.providerId === result.providerId &&
          candidate.externalWorkspaceId === result.externalWorkspaceId,
      )
    : undefined;

  let candidates: RankedCandidate[];
  let resolvedResult = result;
  if (binding) {
    const target = await validateExplicitPath(binding.diffectWorkspacePath);
    if (target) {
      const matchingContext = contextCandidates.find(
        (candidate) =>
          candidate.workspacePath === target.workspacePath ||
          (candidate.anchorPath !== null && target.anchorPaths.includes(candidate.anchorPath)),
      );
      candidates = [
        {
          bound: true,
          candidate: resolutionCandidate(
            result,
            target.workspacePath,
            matchingContext?.anchorPath ?? target.anchorPath,
          ),
        },
      ];
    } else {
      resolvedResult = withDiagnostic(result, "saved workspace binding is no longer valid");
      candidates = contextCandidates.map((candidate) => ({
        bound: false,
        candidate: resolutionCandidate(
          result,
          candidate.workspacePath,
          candidate.anchorPath,
        ),
      }));
    }
  } else {
    candidates = contextCandidates.map((candidate) => ({
      bound: false,
      candidate: resolutionCandidate(
        result,
        candidate.workspacePath,
        candidate.anchorPath,
      ),
    }));
  }

  const invalidCount = result.candidatePaths.length - contextCandidates.length;
  return {
    result: invalidCount > 0
      ? withDiagnostic(
          resolvedResult,
          `${invalidCount} workspace candidate${invalidCount === 1 ? " was" : "s were"} invalid`,
        )
      : resolvedResult,
    candidates,
  };
}

function resolutionCandidate(
  result: WorkspaceProviderResult,
  workspacePath: string,
  anchorPath: string | null,
): WorkspaceResolutionCandidate {
  return {
    workspacePath,
    anchorPath,
    providerId: result.providerId,
    ...(result.externalWorkspaceId === undefined
      ? {}
      : { externalWorkspaceId: result.externalWorkspaceId }),
    label: result.label ?? basename(workspacePath),
    matchedSession: result.matchedSession,
  };
}

function dedupeRankedCandidates(candidates: RankedCandidate[]): RankedCandidate[] {
  const byWorkspace = new Map<string, RankedCandidate>();
  for (const item of candidates) {
    const existing = byWorkspace.get(item.candidate.workspacePath);
    if (!existing) {
      byWorkspace.set(item.candidate.workspacePath, item);
      continue;
    }
    if (item.bound && !existing.bound) {
      byWorkspace.set(item.candidate.workspacePath, item);
      continue;
    }
    if (
      item.bound === existing.bound &&
      !existing.candidate.matchedSession &&
      item.candidate.matchedSession
    ) {
      existing.candidate = item.candidate;
    }
  }
  return [...byWorkspace.values()];
}

interface ValidatedPath {
  workspacePath: string;
  anchorPath: string | null;
  /** Canonical repo/worktree roots that are valid anchors within this workspace. */
  anchorPaths: string[];
}

/** Explicit paths and bindings choose their exact repo or container boundary. */
async function validateExplicitPath(path: string): Promise<ValidatedPath | null> {
  const dir = await existingDirectory(path);
  if (!dir) return null;
  const repoRoot = await gitTry(dir, ["rev-parse", "--show-toplevel"]);
  if (repoRoot) {
    const root = realpathSafe(resolve(repoRoot));
    return { workspacePath: root, anchorPath: root, anchorPaths: [root] };
  }
  try {
    const workspace = await discoverWorkspace(dir);
    return {
      workspacePath: realpathSafe(workspace.root),
      anchorPath: null,
      anchorPaths: workspaceAnchorPaths(workspace),
    };
  } catch {
    return null;
  }
}

/** Session/cwd context may promote a repo under `worktrees/<ticket>/` to its space. */
async function validateContextPath(path: string): Promise<ValidatedPath | null> {
  const dir = await existingDirectory(path);
  if (!dir) return null;
  const repoRoot = await gitTry(dir, ["rev-parse", "--show-toplevel"]);
  if (!repoRoot) return validateExplicitPath(dir);

  const anchorPath = realpathSafe(resolve(repoRoot));
  const parent = dirname(anchorPath);
  if (basename(dirname(parent)) === "worktrees") {
    try {
      const workspace = await discoverWorkspace(parent);
      return {
        workspacePath: realpathSafe(workspace.root),
        anchorPath,
        anchorPaths: workspaceAnchorPaths(workspace),
      };
    } catch {
      // Fall back to the repo itself when the expected container is not reviewable.
    }
  }
  return { workspacePath: anchorPath, anchorPath, anchorPaths: [anchorPath] };
}

function workspaceAnchorPaths(workspace: Workspace): string[] {
  return workspace.repos.flatMap((repo) =>
    repo.worktrees.map((worktree) => realpathSafe(worktree.root)),
  );
}

async function existingDirectory(path: string): Promise<string | null> {
  const absolute = resolve(path);
  const info = await stat(absolute).catch(() => null);
  if (!info) return null;
  return info.isDirectory() ? absolute : dirname(absolute);
}

function withDiagnostic(
  result: WorkspaceProviderResult,
  message: string,
): WorkspaceProviderResult {
  return {
    ...result,
    message: result.message ? `${result.message}; ${message}` : message,
  };
}

function objectValue(
  value: unknown,
  path: string,
  issues: SettingsValidationIssue[],
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issue(issues, path, "must be an object");
    return null;
  }
  return value as Record<string, unknown>;
}

function optionalAbsolutePath(
  value: unknown,
  path: string,
  issues: SettingsValidationIssue[],
): string | null | undefined {
  if (value === undefined) return undefined;
  const parsed = optionalNonEmptyString(value, path, issues);
  if (parsed === null || parsed === undefined) return parsed;
  if (!isAbsolute(parsed)) {
    issue(issues, path, "must be an absolute path");
    return null;
  }
  return parsed;
}

function optionalNonEmptyString(
  value: unknown,
  path: string,
  issues: SettingsValidationIssue[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    issue(issues, path, "must be a non-empty string");
    return null;
  }
  return value;
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: SettingsValidationIssue[],
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) issue(issues, path ? `${path}.${key}` : key, "is not supported");
  }
}

function issue(
  issues: SettingsValidationIssue[],
  path: string,
  message: string,
): void {
  issues.push({ path, message });
}
