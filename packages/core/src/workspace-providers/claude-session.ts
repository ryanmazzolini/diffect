import type { WorkspaceProviderResult } from "@diffect/shared";
import { discoverSessionProvider } from "./session.js";
import type {
  ClaudeSessionProviderConfig,
  WorkspaceProviderContext,
} from "./types.js";

export function discoverClaudeSessionWorkspaces(
  config: ClaudeSessionProviderConfig,
  context: WorkspaceProviderContext,
): Promise<WorkspaceProviderResult[]> {
  return discoverSessionProvider(
    { providerId: config.id, root: config.projectsPath, kind: "claude" },
    context,
  );
}
