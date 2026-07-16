import type { WorkspaceProviderResult } from "@diffect/shared";
import { discoverSessionProvider } from "./session.js";
import type {
  PiSessionProviderConfig,
  WorkspaceProviderContext,
} from "./types.js";

export function discoverPiSessionWorkspaces(
  config: PiSessionProviderConfig,
  context: WorkspaceProviderContext,
): Promise<WorkspaceProviderResult[]> {
  return discoverSessionProvider(
    { providerId: config.id, root: config.sessionsPath, kind: "pi" },
    context,
  );
}
