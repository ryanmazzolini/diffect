import type { WorkspaceProviderResult } from "@diffect/shared";
import type { CwdProviderConfig, WorkspaceProviderContext } from "./types.js";

export async function discoverCwdWorkspace(
  config: CwdProviderConfig,
  context: WorkspaceProviderContext,
): Promise<WorkspaceProviderResult[]> {
  return [
    context.cwd
      ? {
          providerId: config.id,
          label: "Current directory",
          candidatePaths: [context.cwd],
          matchedSession: false,
          status: "available",
        }
      : {
          providerId: config.id,
          candidatePaths: [],
          matchedSession: false,
          status: "unavailable",
          message: "caller did not provide a working directory",
        },
  ];
}
