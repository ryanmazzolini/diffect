import { isAbsolute } from "node:path";

export interface PiWorkspaceResolutionContext {
  cwd: string;
  sessionId?: string;
  sessionFile?: string;
  sessionCwd?: string;
}

export interface WorkspaceResolutionRequest {
  explicitWorkspace?: string;
  cwd: string;
  agentSession: {
    provider: "pi";
    id?: string;
    path?: string;
    cwd: string;
  };
}

export interface WorkspaceResolutionCandidate {
  workspacePath: string;
  anchorPath: string | null;
  providerId: string | null;
  externalWorkspaceId?: string;
  label?: string;
  matchedSession: boolean;
}

export interface WorkspaceProviderDiagnostic {
  providerId: string;
  status: "available" | "unavailable" | "error";
  message?: string;
}

export interface WorkspaceResolutionResponse {
  selected: WorkspaceResolutionCandidate | null;
  candidates: WorkspaceResolutionCandidate[];
  results: WorkspaceProviderDiagnostic[];
}

interface WorkspaceBinding {
  providerId: string;
  externalWorkspaceId: string;
  diffectWorkspacePath: string;
}

export interface WorkspaceBindingUpdate {
  document: unknown;
  changed: boolean;
}

export function buildPiWorkspaceResolutionRequest(
  context: PiWorkspaceResolutionContext,
  explicitWorkspace?: string,
): WorkspaceResolutionRequest {
  return {
    ...(explicitWorkspace ? { explicitWorkspace } : {}),
    cwd: context.cwd,
    agentSession: {
      provider: "pi",
      ...(context.sessionId ? { id: context.sessionId } : {}),
      ...(context.sessionFile ? { path: context.sessionFile } : {}),
      cwd: context.sessionCwd || context.cwd,
    },
  };
}

export function parseWorkspaceResolutionResponse(
  value: unknown,
): WorkspaceResolutionResponse {
  const root = recordValue(value, "workspace resolution response");
  if (!Array.isArray(root.candidates) || !Array.isArray(root.results)) {
    throw invalidResponse();
  }
  const selected = root.selected === null
    ? null
    : parseCandidate(root.selected, "selected");
  return {
    selected,
    candidates: root.candidates.map((candidate, index) =>
      parseCandidate(candidate, `candidates[${index}]`),
    ),
    results: root.results.map((result, index) =>
      parseDiagnostic(result, `results[${index}]`),
    ),
  };
}

export function decideWorkspaceCandidate(
  response: WorkspaceResolutionResponse,
  options: { forcePicker?: boolean; interactive?: boolean } = {},
): WorkspaceResolutionCandidate | null {
  const selected = options.forcePicker
    ? null
    : response.selected ?? (response.candidates.length === 1
      ? response.candidates[0]!
      : null);
  if (selected) return selected;
  if (response.candidates.length === 0) {
    throw new Error(workspaceResolutionFailure(response));
  }
  if (!options.interactive) {
    throw new Error(
      "Multiple Diffect workspaces found. Run /diffect-space to choose one.",
    );
  }
  return null;
}

export function workspaceResolutionFailure(
  response: WorkspaceResolutionResponse,
): string {
  const diagnostics = [...new Set(
    response.results
      .map((result) => result.message?.trim())
      .filter((message): message is string => Boolean(message)),
  )];
  return diagnostics.length === 0
    ? "No git repo or Diffect workspace was resolved from this session"
    : `No git repo or Diffect workspace was resolved: ${diagnostics.join("; ")}`;
}

export function settingsWithWorkspaceBinding(
  value: unknown,
  candidate: WorkspaceResolutionCandidate,
): WorkspaceBindingUpdate | null {
  if (!candidate.providerId || !candidate.externalWorkspaceId) return null;

  const settings = recordValue(value, "settings");
  const workspaceResolution = recordValue(
    settings.workspaceResolution,
    "settings.workspaceResolution",
  );
  if (!Array.isArray(workspaceResolution.providers) ||
      !Array.isArray(workspaceResolution.bindings)) {
    throw new Error("diffectd returned invalid workspace settings");
  }
  const bindings = workspaceResolution.bindings.map((binding, index) =>
    parseBinding(binding, `settings.workspaceResolution.bindings[${index}]`),
  );
  const existing = bindings.find(
    (binding) =>
      binding.providerId === candidate.providerId &&
      binding.externalWorkspaceId === candidate.externalWorkspaceId,
  );
  if (existing?.diffectWorkspacePath === candidate.workspacePath) {
    return { document: value, changed: false };
  }

  const replacement: WorkspaceBinding = {
    providerId: candidate.providerId,
    externalWorkspaceId: candidate.externalWorkspaceId,
    diffectWorkspacePath: candidate.workspacePath,
  };
  return {
    document: {
      ...settings,
      workspaceResolution: {
        ...workspaceResolution,
        bindings: [
          ...bindings.filter(
            (binding) =>
              binding.providerId !== replacement.providerId ||
              binding.externalWorkspaceId !== replacement.externalWorkspaceId,
          ),
          replacement,
        ],
      },
    },
    changed: true,
  };
}

export function daemonWorkspaceArguments(workspaceRoot?: string): string[] {
  return workspaceRoot
    ? ["--workspace", workspaceRoot]
    : ["--no-workspace"];
}

function parseCandidate(
  value: unknown,
  path: string,
): WorkspaceResolutionCandidate {
  const candidate = recordValue(value, path);
  const workspacePath = absoluteString(candidate.workspacePath);
  const anchorPath = candidate.anchorPath === null
    ? null
    : absoluteString(candidate.anchorPath);
  const providerId = candidate.providerId === null
    ? null
    : nonEmptyString(candidate.providerId);
  const externalWorkspaceId = optionalString(candidate.externalWorkspaceId);
  const label = optionalString(candidate.label);
  if (!workspacePath || anchorPath === undefined || providerId === undefined ||
      externalWorkspaceId === null || label === null ||
      typeof candidate.matchedSession !== "boolean") {
    throw invalidResponse(path);
  }
  return {
    workspacePath,
    anchorPath,
    providerId,
    ...(externalWorkspaceId === undefined ? {} : { externalWorkspaceId }),
    ...(label === undefined ? {} : { label }),
    matchedSession: candidate.matchedSession,
  };
}

function parseDiagnostic(
  value: unknown,
  path: string,
): WorkspaceProviderDiagnostic {
  const diagnostic = recordValue(value, path);
  const providerId = nonEmptyString(diagnostic.providerId);
  const status = diagnostic.status;
  const message = optionalString(diagnostic.message);
  if (!providerId ||
      (status !== "available" && status !== "unavailable" && status !== "error") ||
      message === null) {
    throw invalidResponse(path);
  }
  return {
    providerId,
    status,
    ...(message === undefined ? {} : { message }),
  };
}

function parseBinding(value: unknown, path: string): WorkspaceBinding {
  const binding = recordValue(value, path);
  const providerId = nonEmptyString(binding.providerId);
  const externalWorkspaceId = nonEmptyString(binding.externalWorkspaceId);
  const diffectWorkspacePath = absoluteString(binding.diffectWorkspacePath);
  if (!providerId || !externalWorkspaceId || !diffectWorkspacePath) {
    throw new Error("diffectd returned invalid workspace settings");
  }
  return { providerId, externalWorkspaceId, diffectWorkspacePath };
}

function recordValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse(path);
  }
  return value as Record<string, unknown>;
}

function absoluteString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && isAbsolute(value)
    ? value
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(value) ?? null;
}

function invalidResponse(path?: string): Error {
  return new Error(
    `diffectd returned an invalid workspace resolution${path ? ` at ${path}` : ""}`,
  );
}
