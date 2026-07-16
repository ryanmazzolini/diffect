import { isAbsolute } from "node:path";
import type { WorkspaceProviderResult } from "@diffect/shared";
import {
  ProviderCommandError,
  providerCommandEnvironment,
  runProviderCommand,
  type ProviderCommandRunner,
} from "./command.js";
import type { CmuxProviderConfig, WorkspaceProviderContext } from "./types.js";

interface CmuxSession {
  agent: string;
  sessionId: string;
  workspaceId: string;
  surfaceId: string;
  cwd?: string;
  launchCwd?: string;
  transcriptPath?: string;
}

interface CmuxWorkspace {
  id: string;
  title?: string;
  surfaceIds: Set<string>;
}

interface CmuxSessionList {
  sessions: CmuxSession[];
  totalMatches: number;
}

interface CmuxCurrentWorkspace {
  id: string;
  title?: string;
  currentDirectory?: string;
}

class CmuxOutputError extends Error {
  constructor(message: string) {
    super(`cmux output is incompatible: ${message}`);
    this.name = "CmuxOutputError";
  }
}

export function parseCmuxSessions(output: string): CmuxSessionList {
  const root = parseObject(output);
  if (!Array.isArray(root.sessions)) {
    throw new CmuxOutputError("expected a sessions array");
  }
  const totalMatches = integerValue(root.total_matches);
  if (totalMatches === null || totalMatches < root.sessions.length) {
    throw new CmuxOutputError("expected a valid total_matches count");
  }
  const sessions = root.sessions.map((value, index) => {
    const session = objectValue(value);
    const agent = stringValue(session?.agent);
    const sessionId = stringValue(session?.session_id);
    const workspaceId = stringValue(session?.workspace_id);
    const surfaceId = stringValue(session?.surface_id);
    if (!session || !agent || !sessionId || !workspaceId || !surfaceId) {
      throw new CmuxOutputError(
        `sessions[${index}] is missing agent, session_id, workspace_id, or surface_id`,
      );
    }
    return {
      agent,
      sessionId,
      workspaceId,
      surfaceId,
      ...optionalProperty(session, "cwd", "cwd"),
      ...optionalProperty(session, "launch_working_directory", "launchCwd"),
      ...optionalProperty(session, "transcript_path", "transcriptPath"),
    };
  });
  return { sessions, totalMatches };
}

export function parseCmuxTree(output: string): CmuxWorkspace[] {
  const root = parseObject(output);
  if (!Array.isArray(root.windows)) {
    throw new CmuxOutputError("expected a windows array");
  }
  const workspaces: CmuxWorkspace[] = [];
  for (const [windowIndex, windowValue] of root.windows.entries()) {
    const window = objectValue(windowValue);
    if (!window || !Array.isArray(window.workspaces)) {
      throw new CmuxOutputError(`windows[${windowIndex}] is missing workspaces`);
    }
    for (const [workspaceIndex, workspaceValue] of window.workspaces.entries()) {
      const workspace = objectValue(workspaceValue);
      const id = stringValue(workspace?.id);
      if (!id) {
        throw new CmuxOutputError(
          `windows[${windowIndex}].workspaces[${workspaceIndex}] is missing id`,
        );
      }
      const workspacePath = `windows[${windowIndex}].workspaces[${workspaceIndex}]`;
      const title = optionalString(workspace?.title, `${workspacePath}.title`);
      if (!Array.isArray(workspace?.panes)) {
        throw new CmuxOutputError(`${workspacePath} is missing panes`);
      }
      const surfaceIds = new Set<string>();
      for (const [paneIndex, paneValue] of workspace.panes.entries()) {
        const pane = objectValue(paneValue);
        if (!pane || !Array.isArray(pane.surfaces)) {
          throw new CmuxOutputError(
            `${workspacePath}.panes[${paneIndex}] is missing surfaces`,
          );
        }
        for (const [surfaceIndex, surfaceValue] of pane.surfaces.entries()) {
          const surfaceId = stringValue(objectValue(surfaceValue)?.id);
          if (!surfaceId) {
            throw new CmuxOutputError(
              `${workspacePath}.panes[${paneIndex}].surfaces[${surfaceIndex}] is missing id`,
            );
          }
          surfaceIds.add(surfaceId);
        }
      }
      workspaces.push({ id, ...(title ? { title } : {}), surfaceIds });
    }
  }
  return workspaces;
}

export function parseCmuxCurrentWorkspace(output: string): CmuxCurrentWorkspace {
  const root = parseObject(output);
  const workspaceId = stringValue(root.workspace_id);
  const workspace = objectValue(root.workspace);
  const id = stringValue(workspace?.id) ?? workspaceId;
  if (!workspaceId || !workspace || !id || id !== workspaceId) {
    throw new CmuxOutputError("expected a current workspace summary");
  }
  const title = optionalString(workspace.title, "workspace.title");
  const currentDirectory = optionalString(
    workspace.current_directory,
    "workspace.current_directory",
  );
  return {
    id,
    ...(title ? { title } : {}),
    ...(currentDirectory ? { currentDirectory } : {}),
  };
}

export async function discoverCmuxWorkspaces(
  config: CmuxProviderConfig,
  context: WorkspaceProviderContext,
  run: ProviderCommandRunner = runProviderCommand,
): Promise<WorkspaceProviderResult[]> {
  const diagnostics: WorkspaceProviderResult[] = [];
  const session = context.agentSession;

  if (session?.id) {
    try {
      const snapshot = parseCmuxSessions(
        (
          await runCmux(
            config,
            [
              "sessions",
              "list",
              "--agent",
              session.provider,
              "--session",
              session.id,
              "--all",
              "--limit",
              "20",
            ],
            run,
          )
        ).stdout,
      );
      const sessions = snapshot.sessions.filter(
        (candidate) =>
          candidate.agent === session.provider && candidate.sessionId === session.id,
      );

      if (snapshot.totalMatches > snapshot.sessions.length) {
        diagnostics.push(
          providerNotice(
            config.id,
            `cmux returned ${snapshot.sessions.length} of ${snapshot.totalMatches} matching session records`,
          ),
        );
      } else if (sessions.length > 0) {
        try {
          const openWorkspaces = new Map(
            parseCmuxTree(
              (await runCmux(config, ["tree", "--all"], run)).stdout,
            ).map((workspace) => [workspace.id, workspace]),
          );
          const liveSessions = sessions.filter((candidate) =>
            openWorkspaces
              .get(candidate.workspaceId)
              ?.surfaceIds.has(candidate.surfaceId),
          );
          if (liveSessions.length > 0) {
            return [
              ...diagnostics,
              ...resultsForSessions(config.id, liveSessions, openWorkspaces),
            ];
          }
          diagnostics.push(
            providerNotice(
              config.id,
              "saved cmux session metadata did not match a live surface",
            ),
          );
        } catch (error) {
          diagnostics.push(providerDiagnostic(config.id, error));
        }
      }
    } catch (error) {
      diagnostics.push(providerDiagnostic(config.id, error));
    }
  }

  try {
    const current = parseCmuxCurrentWorkspace(
      (await runCmux(config, ["current-workspace"], run)).stdout,
    );
    return [
      ...diagnostics,
      {
        providerId: config.id,
        externalWorkspaceId: current.id,
        ...(current.title ? { label: current.title } : {}),
        candidatePaths: absolutePaths([current.currentDirectory]),
        matchedSession: false,
        status: "available",
      },
    ];
  } catch (error) {
    return [...diagnostics, providerDiagnostic(config.id, error)];
  }
}

async function runCmux(
  config: CmuxProviderConfig,
  args: string[],
  run: ProviderCommandRunner,
) {
  return run(
    config.command,
    [
      ...(config.socketPath ? ["--socket", config.socketPath] : []),
      "--json",
      ...args,
    ],
    { env: providerCommandEnvironment("CMUX_") },
  );
}

function resultsForSessions(
  providerId: string,
  sessions: CmuxSession[],
  openWorkspaces: Map<string, CmuxWorkspace>,
): WorkspaceProviderResult[] {
  const byWorkspace = new Map<string, CmuxSession[]>();
  for (const session of sessions) {
    const existing = byWorkspace.get(session.workspaceId) ?? [];
    existing.push(session);
    byWorkspace.set(session.workspaceId, existing);
  }
  return [...byWorkspace].map(([workspaceId, matches]) => {
    const workspace = openWorkspaces.get(workspaceId);
    return {
      providerId,
      externalWorkspaceId: workspaceId,
      ...(workspace?.title ? { label: workspace.title } : {}),
      candidatePaths: absolutePaths(
        matches.flatMap((match) => [match.cwd, match.launchCwd]),
      ),
      matchedSession: true,
      status: "available",
    };
  });
}

function providerNotice(
  providerId: string,
  message: string,
): WorkspaceProviderResult {
  return {
    providerId,
    candidatePaths: [],
    matchedSession: false,
    status: "unavailable",
    message,
  };
}

function providerDiagnostic(
  providerId: string,
  error: unknown,
): WorkspaceProviderResult {
  const message = error instanceof Error ? error.message : "cmux provider failed";
  const unavailable =
    error instanceof ProviderCommandError &&
    (error.kind === "unavailable" ||
      /socket not found|connection refused|failed to connect/i.test(message));
  return {
    providerId,
    candidatePaths: [],
    matchedSession: false,
    status: unavailable ? "unavailable" : "error",
    message,
  };
}

function parseObject(output: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new CmuxOutputError("response was not valid JSON");
  }
  const object = objectValue(parsed);
  if (!object) throw new CmuxOutputError("expected a JSON object");
  return object;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function integerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = stringValue(value);
  if (!parsed) throw new CmuxOutputError(`${path} must be a non-empty string`);
  return parsed;
}

function optionalProperty<
  Key extends "cwd" | "launchCwd" | "transcriptPath",
>(
  source: Record<string, unknown>,
  sourceKey: string,
  key: Key,
): Partial<Record<Key, string>> {
  const value = optionalString(source[sourceKey], `session.${sourceKey}`);
  return value ? ({ [key]: value } as Partial<Record<Key, string>>) : {};
}

function absolutePaths(paths: (string | undefined)[]): string[] {
  return [...new Set(paths.filter((path): path is string => !!path && isAbsolute(path)))];
}
