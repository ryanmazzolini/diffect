import { isAbsolute } from "node:path";
import type { WorkspaceProviderResult } from "@diffect/shared";
import {
  ProviderCommandError,
  providerCommandEnvironment,
  runProviderCommand,
  type ProviderCommandRunner,
} from "./command.js";
import type { HerdrProviderConfig, WorkspaceProviderContext } from "./types.js";

interface HerdrAgentSession {
  agent: string;
  kind: "id" | "path";
  value: string;
}

interface HerdrPane {
  paneId: string;
  workspaceId: string;
  cwd?: string;
  foregroundCwd?: string;
  agentSession?: HerdrAgentSession;
}

class HerdrOutputError extends Error {
  constructor(message: string) {
    super(`Herdr output is incompatible: ${message}`);
    this.name = "HerdrOutputError";
  }
}

export function parseHerdrPaneList(output: string): HerdrPane[] {
  const result = resultObject(output);
  if (result.type !== "pane_list" || !Array.isArray(result.panes)) {
    throw new HerdrOutputError("expected a pane_list result");
  }
  return result.panes.map((pane, index) => parsePane(pane, `panes[${index}]`));
}

export function parseHerdrCurrentPane(output: string): HerdrPane {
  const result = resultObject(output);
  if (result.type !== "pane_current") {
    throw new HerdrOutputError("expected a pane_current result");
  }
  return parsePane(result.pane, "pane");
}

export async function discoverHerdrWorkspaces(
  config: HerdrProviderConfig,
  context: WorkspaceProviderContext,
  run: ProviderCommandRunner = runProviderCommand,
): Promise<WorkspaceProviderResult[]> {
  const diagnostics: WorkspaceProviderResult[] = [];
  let listedPanes: HerdrPane[] | undefined;

  if (context.agentSession) {
    try {
      listedPanes = parseHerdrPaneList(
        (await runHerdr(config, ["pane", "list"], run)).stdout,
      );
      const matches = listedPanes.filter((pane) =>
        matchesAgentSession(pane, context.agentSession!),
      );
      if (matches.length > 0) {
        return resultsForMatchedPanes(config.id, matches);
      }
    } catch (error) {
      diagnostics.push(providerDiagnostic(config.id, error));
    }
  }

  let current: HerdrPane;
  try {
    current = parseHerdrCurrentPane(
      (await runHerdr(config, ["pane", "current", "--current"], run)).stdout,
    );
  } catch (error) {
    return [...diagnostics, providerDiagnostic(config.id, error)];
  }

  let workspacePanes = listedPanes?.filter(
    (pane) => pane.workspaceId === current.workspaceId,
  );
  if (!workspacePanes) {
    try {
      workspacePanes = parseHerdrPaneList(
        (
          await runHerdr(
            config,
            ["pane", "list", "--workspace", current.workspaceId],
            run,
          )
        ).stdout,
      ).filter((pane) => pane.workspaceId === current.workspaceId);
    } catch (error) {
      diagnostics.push(providerDiagnostic(config.id, error));
      workspacePanes = [current];
    }
  }

  return [
    ...diagnostics,
    {
      providerId: config.id,
      externalWorkspaceId: current.workspaceId,
      candidatePaths: pathsForWorkspace(current, workspacePanes),
      matchedSession: false,
      status: "available",
    },
  ];
}

async function runHerdr(
  config: HerdrProviderConfig,
  args: string[],
  run: ProviderCommandRunner,
) {
  return run(
    config.command,
    [...(config.session ? ["--session", config.session] : []), ...args],
    { env: providerCommandEnvironment("HERDR_") },
  );
}

function resultsForMatchedPanes(
  providerId: string,
  matches: HerdrPane[],
): WorkspaceProviderResult[] {
  const byWorkspace = new Map<string, HerdrPane[]>();
  for (const pane of matches) {
    const existing = byWorkspace.get(pane.workspaceId) ?? [];
    existing.push(pane);
    byWorkspace.set(pane.workspaceId, existing);
  }

  return [...byWorkspace].map(([workspaceId, matchedPanes]) => ({
    providerId,
    externalWorkspaceId: workspaceId,
    candidatePaths: dedupePaths(
      matchedPanes.flatMap((pane) => [pane.foregroundCwd, pane.cwd]),
    ),
    matchedSession: true,
    status: "available",
  }));
}

function matchesAgentSession(
  pane: HerdrPane,
  session: NonNullable<WorkspaceProviderContext["agentSession"]>,
): boolean {
  const observed = pane.agentSession;
  if (!observed || observed.agent !== session.provider) return false;
  if (observed.kind === "id") return session.id === observed.value;
  return session.path === observed.value;
}

function pathsForWorkspace(primary: HerdrPane, panes: HerdrPane[]): string[] {
  return dedupePaths([
    primary.foregroundCwd,
    primary.cwd,
    ...panes.flatMap((pane) => [pane.foregroundCwd, pane.cwd]),
  ]);
}

function dedupePaths(paths: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (!path || !isAbsolute(path) || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

function providerDiagnostic(
  providerId: string,
  error: unknown,
): WorkspaceProviderResult {
  return {
    providerId,
    candidatePaths: [],
    matchedSession: false,
    status:
      error instanceof ProviderCommandError && error.kind === "unavailable"
        ? "unavailable"
        : "error",
    message: error instanceof Error ? error.message : "Herdr provider failed",
  };
}

function resultObject(output: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new HerdrOutputError("response was not valid JSON");
  }
  const envelope = objectValue(parsed);
  const result = objectValue(envelope?.result);
  if (!result) throw new HerdrOutputError("expected a result envelope");
  return result;
}

function parsePane(value: unknown, path: string): HerdrPane {
  const pane = objectValue(value);
  const paneId = stringValue(pane?.pane_id);
  const workspaceId = stringValue(pane?.workspace_id);
  if (!paneId || !workspaceId) {
    throw new HerdrOutputError(`${path} is missing pane_id or workspace_id`);
  }

  let agentSession: HerdrAgentSession | undefined;
  if (pane?.agent_session !== undefined && pane.agent_session !== null) {
    const raw = objectValue(pane.agent_session);
    const agent = stringValue(raw?.agent);
    const kind = raw?.kind;
    const sessionValue = stringValue(raw?.value);
    if (!agent || (kind !== "id" && kind !== "path") || !sessionValue) {
      throw new HerdrOutputError(`${path}.agent_session is malformed`);
    }
    agentSession = { agent, kind, value: sessionValue };
  }

  const cwd = optionalString(pane?.cwd, `${path}.cwd`);
  const foregroundCwd = optionalString(
    pane?.foreground_cwd,
    `${path}.foreground_cwd`,
  );
  return {
    paneId,
    workspaceId,
    ...(cwd ? { cwd } : {}),
    ...(foregroundCwd ? { foregroundCwd } : {}),
    ...(agentSession ? { agentSession } : {}),
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = stringValue(value);
  if (!parsed) throw new HerdrOutputError(`${path} must be a non-empty string`);
  return parsed;
}
