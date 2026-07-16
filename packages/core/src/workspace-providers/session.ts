import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { WorkspaceProviderResult } from "@diffect/shared";
import {
  readSessionCwd,
  scanSessionProjects,
  type SessionLogKind,
} from "./session-log.js";
import type { WorkspaceProviderContext } from "./types.js";

interface SessionProviderOptions {
  providerId: string;
  root: string;
  kind: SessionLogKind;
}

export async function discoverSessionProvider(
  options: SessionProviderOptions,
  context: WorkspaceProviderContext,
): Promise<WorkspaceProviderResult[]> {
  const agentProvider = options.kind === "pi" ? "pi" : "claude";
  if (context.agentSession?.provider === agentProvider) {
    const session = context.agentSession;
    const cwd = session.cwd ?? (session.path ? await readSessionCwd(session.path) : null);
    return [
      cwd
        ? {
            providerId: options.providerId,
            externalWorkspaceId: session.path
              ? dirname(session.path)
              : session.id ?? cwd,
            label: basename(cwd),
            candidatePaths: [cwd],
            matchedSession: true,
            status: "available",
          }
        : {
            providerId: options.providerId,
            candidatePaths: [],
            matchedSession: true,
            status: "error",
            message: "matched agent session does not expose a working directory",
          },
    ];
  }

  const info = await stat(options.root).catch(() => null);
  if (!info?.isDirectory()) {
    return [
      {
        providerId: options.providerId,
        candidatePaths: [],
        matchedSession: false,
        status: "unavailable",
        message: "session directory is unavailable",
      },
    ];
  }

  const projects = await scanSessionProjects(options.root, options.kind);
  if (projects.length === 0) {
    return [
      {
        providerId: options.providerId,
        candidatePaths: [],
        matchedSession: false,
        status: "available",
        message: "no session projects found",
      },
    ];
  }
  return projects.map((project) => ({
    providerId: options.providerId,
    externalWorkspaceId: project.projectDir,
    label: basename(project.cwd),
    candidatePaths: [project.cwd],
    matchedSession: false,
    status: "available",
  }));
}
