import type {
  AgentSessionContext,
  WorkspaceProviderConfig,
  WorkspaceProviderResult,
} from "@diffect/shared";

export interface WorkspaceProviderContext {
  cwd?: string;
  agentSession?: AgentSessionContext;
}

export type PiSessionProviderConfig = Extract<
  WorkspaceProviderConfig,
  { kind: "pi-session" }
>;

export type ClaudeSessionProviderConfig = Extract<
  WorkspaceProviderConfig,
  { kind: "claude-session" }
>;

export type CwdProviderConfig = Extract<WorkspaceProviderConfig, { kind: "cwd" }>;

export type ProviderDiscovery = (
  context: WorkspaceProviderContext,
) => Promise<WorkspaceProviderResult[]>;
