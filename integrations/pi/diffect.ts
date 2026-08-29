import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  acceptsFeedback,
  filterFeedbackJson,
  rememberEventId,
  watchFeedbackEvents,
  watchStatusLabel,
  type FeedbackEvent,
} from "./watch.js";
import { findLocalFile, resolveTrustedCommand } from "./local-files.js";
import {
  buildPiWorkspaceResolutionRequest,
  decideWorkspaceCandidate,
  parseWorkspaceResolutionResponse,
  persistWorkspaceBinding,
  type WorkspaceResolutionCandidate,
  type WorkspaceResolutionResponse,
} from "./workspace-resolution.js";

export const CANONICAL_LOCAL_ORIGIN = "http://127.0.0.1:13433";
const DEFAULT_TARGET = "work";
const MAX_OUTPUT = 50_000;
const WATCH_ENTRY = "diffect-feedback-watch";
const WATCH_STATUS = "diffect-watch";
const FEEDBACK_BATCH_MS = 250;
const MAX_WORKSPACE_CHOICES = 12;

type Command = { command: string; args: string[] };
type RepoLocation = { repo: string; worktree: string | null };
type ReviewMode = "feedback" | "proactive";
type ReviewWorkspace = { workspaceRoot: string; anchorRoot: string | null };
type WorkspaceResolveOptions = {
  forcePicker?: boolean;
  interactive?: boolean;
  persistSelection?: boolean;
};
type WatchConfig = {
  enabled: boolean;
  workspaceRoot: string;
  agentLabel: string;
  includeAgents: boolean;
};
type WatchRuntime = {
  config: WatchConfig;
  controller: AbortController;
  agentName: string;
  seenEventIds: Set<string>;
};
type SessionLike = {
  sessionManager?: {
    getBranch?: () => unknown[];
    getEntries?: () => unknown[];
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
    getCwd?: () => string;
  };
};
type CwdContext = SessionLike & {
  cwd: string;
  ui?: { select?: (title: string, choices: string[]) => Promise<string | undefined> };
};

export default function diffectExtension(pi: ExtensionAPI) {
  let sessionContext: ExtensionContext | null = null;
  let watchConfig: WatchConfig | null = null;
  let watchRuntime: WatchRuntime | null = null;
  let sessionAgentName = "pi";
  let feedbackTimer: NodeJS.Timeout | null = null;
  let flushingFeedback = false;
  const pendingFeedback = new Map<string, FeedbackEvent>();

  function stopFeedbackWatch() {
    watchRuntime?.controller.abort();
    watchRuntime = null;
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = null;
    pendingFeedback.clear();
    sessionContext?.ui.setStatus(WATCH_STATUS, undefined);
  }

  function scheduleFeedback() {
    if (feedbackTimer) return;
    feedbackTimer = setTimeout(() => {
      feedbackTimer = null;
      flushFeedback();
    }, FEEDBACK_BATCH_MS);
  }

  function flushFeedback() {
    const ctx = sessionContext;
    const runtime = watchRuntime;
    if (flushingFeedback || !ctx || !runtime || pendingFeedback.size === 0) return;
    if (!ctx.isIdle()) return;

    const events = [...pendingFeedback.values()];
    pendingFeedback.clear();
    flushingFeedback = true;
    try {
      pi.sendUserMessage(
        diffectFeedbackPrompt(events, runtime.config.workspaceRoot, runtime.agentName),
      );
    } catch {
      // Another extension may have started a turn after isIdle(). Preserve the
      // batch and let agent_settled retry instead of losing or duplicating it.
      if (watchRuntime === runtime) {
        for (const event of events) pendingFeedback.set(event.eventId, event);
      }
    } finally {
      flushingFeedback = false;
    }
  }

  async function startFeedbackWatch(
    ctx: ExtensionContext,
    config: WatchConfig,
  ): Promise<string | null> {
    sessionContext = ctx;
    sessionAgentName = scopedAgentName(config.agentLabel, ctx.sessionManager.getSessionId());
    if (
      watchRuntime &&
      !watchRuntime.controller.signal.aborted &&
      sameWatchConfig(watchRuntime.config, config)
    ) {
      return watchRuntime.agentName;
    }

    stopFeedbackWatch();
    watchConfig = config;
    const controller = new AbortController();
    const runtime: WatchRuntime = {
      config,
      controller,
      agentName: sessionAgentName,
      seenEventIds: new Set(),
    };
    watchRuntime = runtime;
    ctx.ui.setStatus(WATCH_STATUS, watchStatusLabel("connecting"));

    try {
      const connectDaemon = async (signal: AbortSignal) => {
        const url = await ensureDaemon(pi, config.workspaceRoot, signal);
        await registerWorkspace(url, config.workspaceRoot, signal);
        return url;
      };
      const baseUrl = await connectDaemon(controller.signal);
      if (watchRuntime !== runtime || controller.signal.aborted) return null;

      void watchFeedbackEvents({
        baseUrl,
        signal: controller.signal,
        reconnect: connectDaemon,
        onState(state) {
          if (watchRuntime === runtime) {
            sessionContext?.ui.setStatus(WATCH_STATUS, watchStatusLabel(state));
          }
        },
        onFeedback(event) {
          if (watchRuntime !== runtime) return;
          if (
            !acceptsFeedback(event, {
              workspaceRoot: config.workspaceRoot,
              includeAgents: config.includeAgents,
              agentName: runtime.agentName,
            }) ||
            !rememberEventId(runtime.seenEventIds, event.eventId)
          ) {
            return;
          }
          pendingFeedback.set(event.eventId, event);
          scheduleFeedback();
        },
      }).catch((error) => {
        if (watchRuntime !== runtime || controller.signal.aborted) return;
        ctx.ui.setStatus(WATCH_STATUS, watchStatusLabel("disconnected"));
        ctx.ui.notify(`Diffect feedback watch stopped: ${messageOf(error)}`, "warning");
      });
      return runtime.agentName;
    } catch (error) {
      if (watchRuntime === runtime) {
        watchRuntime = null;
        ctx.ui.setStatus(WATCH_STATUS, watchStatusLabel("disconnected"));
      }
      if (controller.signal.aborted) return null;
      throw error;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    watchConfig = latestWatchConfig(ctx);
    sessionAgentName = scopedAgentName(
      watchConfig?.agentLabel ?? "pi",
      ctx.sessionManager.getSessionId(),
    );
    if (!watchConfig?.enabled) return;

    void startFeedbackWatch(ctx, watchConfig).catch((error) => {
      ctx.ui.setStatus(WATCH_STATUS, watchStatusLabel("disconnected"));
      ctx.ui.notify(`Diffect feedback reconnect failed: ${messageOf(error)}`, "warning");
    });
  });

  pi.on("agent_settled", (_event, ctx) => {
    sessionContext = ctx;
    flushFeedback();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopFeedbackWatch();
    ctx.ui.setStatus(WATCH_STATUS, undefined);
    sessionContext = null;
  });

  pi.registerCommand("diffect-connect", {
    description: "Watch this Pi session's Diffect feedback",
    handler: async (args, ctx) => {
      try {
        const parsed = parseConnectArgs(args);
        const workspace = await resolveReviewWorkspace(
          pi,
          ctx,
          parsed.workspace,
          undefined,
          { interactive: true, persistSelection: true },
        );
        const config: WatchConfig = {
          enabled: true,
          workspaceRoot: workspace.workspaceRoot,
          agentLabel: parsed.agentLabel ?? watchConfig?.agentLabel ?? "pi",
          includeAgents: parsed.includeAgents ?? watchConfig?.includeAgents ?? false,
        };
        validateAgentLabel(config.agentLabel);
        if (
          watchRuntime &&
          !watchRuntime.controller.signal.aborted &&
          sameWatchConfig(watchRuntime.config, config)
        ) {
          ctx.ui.notify(
            `Already watching Diffect feedback for ${shortPath(config.workspaceRoot)} as ${watchRuntime.agentName}`,
            "info",
          );
          return;
        }
        const name = await startFeedbackWatch(ctx, config);
        if (!name) return;
        watchConfig = config;
        pi.appendEntry(WATCH_ENTRY, config);
        ctx.ui.notify(
          `Watching Diffect feedback for ${shortPath(config.workspaceRoot)} as ${name}${
            config.includeAgents ? " (including other agents)" : ""
          }`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`Diffect connect failed: ${messageOf(error)}`, "error");
      }
    },
  });

  pi.registerCommand("diffect-disconnect", {
    description: "Stop watching Diffect feedback",
    handler: async (_args, ctx) => {
      const previous = watchConfig ?? latestWatchConfig(ctx);
      if (!watchRuntime && !previous?.enabled) {
        ctx.ui.notify("Diffect feedback watch is already disconnected", "info");
        return;
      }
      stopFeedbackWatch();
      if (previous) {
        watchConfig = { ...previous, enabled: false };
        pi.appendEntry(WATCH_ENTRY, watchConfig);
      }
      ctx.ui.notify("Diffect feedback watch disconnected", "info");
    },
  });

  pi.registerCommand("diffect", {
    description: "Open the current Diffect workspace",
    handler: async (args, ctx) => {
      try {
        const parsed = parseCommandArgs(args, ctx.cwd);
        const { url, workspaceRoot } = await diffectUrl(pi, ctx, parsed.target, parsed.workspace, undefined, {
          interactive: true,
          persistSelection: true,
        });
        await openUrl(pi, workspaceRoot, url);
        ctx.ui.notify(`Diffect: ${url}`, "info");
      } catch (err) {
        ctx.ui.notify(`Diffect failed: ${messageOf(err)}`, "error");
      }
    },
  });

  pi.registerCommand("diffect-space", {
    description: "Choose this session's Diffect workspace",
    handler: async (_args, ctx) => {
      try {
        const workspace = await resolveReviewWorkspace(pi, ctx, undefined, undefined, {
          forcePicker: true,
          interactive: true,
          persistSelection: true,
        });
        ctx.ui.notify(`Diffect workspace: ${shortPath(workspace.workspaceRoot)}`, "info");
      } catch (err) {
        ctx.ui.notify(`Diffect workspace failed: ${messageOf(err)}`, "error");
      }
    },
  });

  pi.registerCommand("diffect-review", {
    description: "Ask the agent to review Diffect feedback",
    handler: async (args, ctx) => {
      try {
        const parsed = parseReviewCommandArgs(args, ctx.cwd);
        const { workspaceRoot } = await resolveReviewWorkspace(pi, ctx, parsed.workspace, undefined, {
          interactive: true,
          persistSelection: true,
        });
        pi.sendUserMessage(diffectReviewPrompt(parsed.mode, workspaceRoot));
      } catch (err) {
        ctx.ui.notify(`Diffect review failed: ${messageOf(err)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "diffect_open",
    label: "Diffect Open",
    description: "Start/reuse diffectd and return the current workspace's Diffect URL.",
    promptSnippet: "Open the current workspace in Diffect's local review UI",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Review target, default: work" })),
      workspace: Type.Optional(Type.String({ description: "Workspace/space path; inferred when omitted" })),
      open: Type.Optional(Type.Boolean({ description: "Also ask the OS to open the URL" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { url, workspaceRoot, repoRoot } = await diffectUrl(
        pi,
        ctx,
        params.target ?? DEFAULT_TARGET,
        params.workspace,
        signal,
      );
      if (params.open) await openUrl(pi, workspaceRoot, url, signal);
      return textResult(url, { url, workspaceRoot, repoRoot });
    },
  });

  pi.registerTool({
    name: "diffect_list_feedback",
    label: "Diffect Feedback",
    description: "List Diffect review feedback as JSON using the local store.",
    promptSnippet: "List open Diffect review feedback before making review fixes",
    promptGuidelines: [
      "Use diffect_list_feedback when the user asks to address Diffect review feedback, comments, or threads.",
    ],
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "open, closed, or all; default: open" })),
      ids: Type.Optional(Type.Array(Type.String(), { description: "Return only these thread ids" })),
      repo: Type.Optional(Type.String()),
      worktree: Type.Optional(Type.String()),
      workspace: Type.Optional(Type.String({ description: "Workspace/space path; inferred when omitted" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["list", "--json"];
      if (params.status && params.status !== "all") args.push("--status", params.status);
      if (params.repo) args.push("--repo", params.repo);
      if (params.worktree) args.push("--worktree", params.worktree);
      const result = await runDiffectTool(pi, ctx, args, signal, params.workspace);
      return params.ids ? filterFeedbackResult(result, params.ids) : result;
    },
  });

  pi.registerTool({
    name: "diffect_reply",
    label: "Diffect Reply",
    description: "Reply to a Diffect review thread/comment as an agent.",
    parameters: Type.Object({
      id: Type.String({ description: "Diffect thread id" }),
      body: Type.String({ description: "Reply body" }),
      agent: Type.Optional(Type.String({ description: "Agent author name; defaults to this Pi session" })),
      workspace: Type.Optional(Type.String({ description: "Workspace/space path; inferred when omitted" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return runDiffectTool(
        pi,
        ctx,
        ["reply", params.id, "--agent", params.agent ?? sessionAgentName, "--body", params.body],
        signal,
        params.workspace,
      );
    },
  });

  pi.registerTool({
    name: "diffect_resolve",
    label: "Diffect Resolve",
    description: "Resolve a Diffect review thread/comment as an agent.",
    parameters: Type.Object({
      id: Type.String({ description: "Diffect thread id" }),
      summary: Type.String({ description: "What changed / why it is resolved" }),
      agent: Type.Optional(Type.String({ description: "Agent author name; defaults to this Pi session" })),
      workspace: Type.Optional(Type.String({ description: "Workspace/space path; inferred when omitted" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return runDiffectTool(
        pi,
        ctx,
        ["resolve", params.id, "--agent", params.agent ?? sessionAgentName, "--summary", params.summary],
        signal,
        params.workspace,
      );
    },
  });

  pi.registerTool({
    name: "diffect_pr",
    label: "Diffect PR",
    description: "Get or update the local PR Draft packet for a Diffect repo.",
    promptSnippet: "Get or update Diffect's local PR Draft title/body",
    parameters: Type.Object({
      action: Type.Optional(Type.String({ description: "get, update, or copy_body; default get" })),
      title: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      repo: Type.Optional(Type.String({ description: "Repo name; required when the workspace has multiple repos" })),
      worktree: Type.Optional(Type.String({ description: "Worktree name" })),
      workspace: Type.Optional(Type.String({ description: "Workspace/space path; inferred when omitted" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const action = params.action || "get";
      const scopeArgs: string[] = [];
      if (params.repo) scopeArgs.push("--repo", params.repo);
      if (params.worktree) scopeArgs.push("--worktree", params.worktree);
      if (action === "get" || action === "copy_body") {
        const result = await runDiffectTool(pi, ctx, ["pr", "get", ...scopeArgs], signal, params.workspace);
        if (action === "copy_body") {
          const parsed = JSON.parse((result.details as { stdout: string }).stdout) as { body?: unknown };
          return textResult(typeof parsed.body === "string" ? parsed.body : "", result.details);
        }
        return result;
      }
      if (action === "update") {
        const args = ["pr", "update", ...scopeArgs];
        if (params.title !== undefined) args.push("--title", params.title);
        if (params.body !== undefined) args.push("--body", params.body);
        if (params.title === undefined && params.body === undefined) throw new Error("title or body is required for update");
        return runDiffectTool(pi, ctx, args, signal, params.workspace);
      }
      throw new Error(`unknown diffect_pr action: ${action}`);
    },
  });

  pi.registerTool({
    name: "diffect_comment",
    label: "Diffect Comment",
    description: "Create a Diffect review comment on a file line/range as an agent.",
    promptSnippet: "Create a Diffect review comment on a file line/range",
    promptGuidelines: [
      "Use diffect_comment for proactive Diffect review comments.",
    ],
    parameters: Type.Object({
      file: Type.String(),
      line: Type.Number(),
      endLine: Type.Optional(Type.Number()),
      side: Type.Optional(Type.String({ description: "new or old; default: new" })),
      severity: Type.Optional(Type.String({ description: "must-fix, suggestion, nit, or question" })),
      target: Type.Optional(Type.String({ description: "Review target, default: work" })),
      repo: Type.Optional(Type.String()),
      worktree: Type.Optional(Type.String()),
      workspace: Type.Optional(Type.String({ description: "Workspace/space path; inferred when omitted" })),
      body: Type.String(),
      agent: Type.Optional(Type.String({ description: "Agent author name; defaults to this Pi session" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = [
        "comment",
        "--file",
        params.file,
        "--line",
        String(params.line),
        "--side",
        params.side ?? "new",
        "--target",
        params.target ?? DEFAULT_TARGET,
        "--agent",
        params.agent ?? sessionAgentName,
        "--body",
        params.body,
      ];
      if (params.endLine !== undefined) args.push("--end-line", String(params.endLine));
      if (params.severity) args.push("--severity", params.severity);
      if (params.repo) args.push("--repo", params.repo);
      if (params.worktree) args.push("--worktree", params.worktree);
      return runDiffectTool(pi, ctx, args, signal, params.workspace);
    },
  });
}

async function diffectUrl(
  pi: ExtensionAPI,
  ctx: CwdContext,
  target: string,
  explicitWorkspace?: string,
  signal?: AbortSignal,
  options?: WorkspaceResolveOptions,
): Promise<{ url: string; workspaceRoot: string; repoRoot: string | null }> {
  const { workspaceRoot, anchorRoot } = await resolveReviewWorkspace(
    pi,
    ctx,
    explicitWorkspace,
    signal,
    options,
  );
  const baseUrl = await ensureDaemon(pi, workspaceRoot, signal);
  await registerWorkspace(baseUrl, workspaceRoot, signal);
  const loc = await locateRepo(baseUrl, workspaceRoot, anchorRoot, signal);
  const q = new URLSearchParams({ workspace: workspaceRoot, repo: loc.repo, target });
  if (loc.worktree) q.set("worktree", loc.worktree);
  return { url: `${baseUrl}/?${q}`, workspaceRoot, repoRoot: anchorRoot };
}

function parseCommandArgs(raw: string, cwd: string): { target: string; workspace?: string } {
  const tokens = splitArgs(raw.trim());
  if (tokens[0] === "--workspace" || tokens[0] === "-w") {
    return { workspace: tokens[1], target: tokens.slice(2).join(" ") || DEFAULT_TARGET };
  }
  if (tokens[0] && existsSync(resolveUserPath(tokens[0], cwd))) {
    return { workspace: tokens[0], target: tokens.slice(1).join(" ") || DEFAULT_TARGET };
  }
  return { target: raw.trim() || DEFAULT_TARGET };
}

function splitArgs(raw: string): string[] {
  return raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
}

function parseConnectArgs(raw: string): {
  workspace?: string;
  agentLabel?: string;
  includeAgents?: boolean;
} {
  const tokens = splitArgs(raw.trim());
  const parsed: { workspace?: string; agentLabel?: string; includeAgents?: boolean } = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--workspace" || token === "-w") {
      parsed.workspace = tokens[++index];
      if (!parsed.workspace) throw new Error("--workspace requires a path");
    } else if (token === "--agent") {
      parsed.agentLabel = tokens[++index];
      if (!parsed.agentLabel) throw new Error("--agent requires a label");
    } else if (token === "--include-agents") {
      parsed.includeAgents = true;
    } else if (token === "--users-only") {
      parsed.includeAgents = false;
    } else {
      throw new Error(
        "Usage: /diffect-connect [--workspace PATH] [--agent LABEL] [--include-agents|--users-only]",
      );
    }
  }
  return parsed;
}

function validateAgentLabel(label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(label)) {
    throw new Error("Agent label must use 1-48 letters, numbers, dots, underscores, or hyphens");
  }
}

function scopedAgentName(label: string, sessionId: string): string {
  const suffix = sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "session";
  return `${label}/${suffix}`;
}

function sameWatchConfig(left: WatchConfig, right: WatchConfig): boolean {
  return (
    left.enabled === right.enabled &&
    real(left.workspaceRoot) === real(right.workspaceRoot) &&
    left.agentLabel === right.agentLabel &&
    left.includeAgents === right.includeAgents
  );
}

function latestWatchConfig(ctx: SessionLike): WatchConfig | null {
  for (const entry of safeSessionEntries(ctx).slice().reverse()) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== WATCH_ENTRY) continue;
    const data = entry.data;
    if (
      !isRecord(data) ||
      typeof data.enabled !== "boolean" ||
      typeof data.workspaceRoot !== "string" ||
      !data.workspaceRoot ||
      typeof data.agentLabel !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(data.agentLabel) ||
      typeof data.includeAgents !== "boolean"
    ) {
      continue;
    }
    return {
      enabled: data.enabled,
      workspaceRoot: data.workspaceRoot,
      agentLabel: data.agentLabel,
      includeAgents: data.includeAgents,
    };
  }
  return null;
}

function parseReviewCommandArgs(raw: string, cwd: string): { mode: ReviewMode; workspace?: string } {
  const tokens = splitArgs(raw.trim());
  let mode: ReviewMode = "feedback";
  if (["proactive", "comment", "comments", "review"].includes(tokens[0] ?? "")) {
    mode = "proactive";
    tokens.shift();
  } else if (["feedback", "fix", "fixes"].includes(tokens[0] ?? "")) {
    tokens.shift();
  }
  if (tokens[0] === "--workspace" || tokens[0] === "-w") return { mode, workspace: tokens[1] };
  if (tokens[0] && existsSync(resolveUserPath(tokens[0], cwd))) return { mode, workspace: tokens[0] };
  return { mode };
}

function diffectReviewPrompt(mode: ReviewMode, workspaceRoot: string): string {
  const workspace = JSON.stringify(workspaceRoot);
  if (mode === "proactive") {
    return `Review the Diffect workspace at ${workspaceRoot}.\n\nInspect the current changes. Do not edit files. Create concise diffect_comment comments for must-fix issues only, passing workspace: ${workspace}. If there are no must-fix issues, say so.`;
  }
  return `Review open Diffect feedback for workspace ${workspaceRoot}.\n\nFirst call diffect_list_feedback with status: "open" and workspace: ${workspace}. Summarize the open comments/threads, then apply the smallest safe fixes. Verify before using diffect_reply or diffect_resolve, and only resolve threads you actually addressed.`;
}

function diffectFeedbackPrompt(
  events: FeedbackEvent[],
  workspaceRoot: string,
  agentName: string,
): string {
  const ids = [...new Set(events.map((event) => event.threadId))];
  return `New Diffect feedback arrived for workspace ${workspaceRoot}.\n\nFirst call diffect_list_feedback with status: "open", ids: ${JSON.stringify(ids)}, and workspace: ${JSON.stringify(workspaceRoot)}. Only inspect and address those threads. If none are open, stop. Apply the smallest safe fixes, verify them, then reply or resolve only what you addressed. Your default Diffect author identity is ${JSON.stringify(agentName)}.`;
}

async function resolveReviewWorkspace(
  pi: ExtensionAPI,
  ctx: CwdContext,
  explicitWorkspace?: string,
  signal?: AbortSignal,
  options: WorkspaceResolveOptions = {},
): Promise<ReviewWorkspace> {
  const baseUrl = await ensureDaemon(pi, ctx.cwd, signal);
  const sessionManager = ctx.sessionManager;
  const request = buildPiWorkspaceResolutionRequest(
    {
      cwd: ctx.cwd,
      sessionId: sessionManager?.getSessionId?.(),
      sessionFile: sessionManager?.getSessionFile?.(),
      sessionCwd: sessionManager?.getCwd?.(),
    },
    explicitWorkspace
      ? resolveUserPath(explicitWorkspace, ctx.cwd)
      : undefined,
    options.forcePicker ? { selectionMode: "choose" } : undefined,
  );
  const response = await requestWorkspaceResolution(baseUrl, request, signal);
  let candidate = decideWorkspaceCandidate(response, {
    forcePicker: options.forcePicker,
    interactive: options.interactive,
  });
  const selectedInteractively = candidate === null;
  if (!candidate) candidate = await pickWorkspace(ctx, response.candidates);

  if (selectedInteractively && options.persistSelection) {
    await persistWorkspaceBinding(baseUrl, candidate, signal);
  }
  return {
    workspaceRoot: candidate.workspacePath,
    anchorRoot: candidate.anchorPath,
  };
}

async function requestWorkspaceResolution(
  baseUrl: string,
  request: ReturnType<typeof buildPiWorkspaceResolutionRequest>,
  signal?: AbortSignal,
): Promise<WorkspaceResolutionResponse> {
  const response = await fetch(`${baseUrl}/workspace-resolution`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        "diffectd does not support workspace resolution; restart or update Diffect",
      );
    }
    throw new Error(await responseError(response));
  }
  return parseWorkspaceResolutionResponse(await response.json());
}

async function pickWorkspace(
  ctx: CwdContext,
  candidates: WorkspaceResolutionCandidate[],
): Promise<WorkspaceResolutionCandidate> {
  if (!ctx.ui?.select) {
    throw new Error(
      "Multiple Diffect workspaces found. Run /diffect-space to choose one.",
    );
  }
  const choices = candidates
    .slice(0, MAX_WORKSPACE_CHOICES)
    .map(formatWorkspaceChoice);
  const selected = await ctx.ui.select("Choose Diffect workspace", choices);
  const index = selected ? choices.indexOf(selected) : -1;
  if (index < 0) throw new Error("Diffect workspace selection cancelled.");
  return candidates[index]!;
}

function formatWorkspaceChoice(
  candidate: WorkspaceResolutionCandidate,
  index: number,
): string {
  const anchor = candidate.anchorPath &&
      real(candidate.anchorPath) !== real(candidate.workspacePath)
    ? ` · ${basename(candidate.anchorPath)}`
    : "";
  const provider = candidate.providerId ? ` · ${candidate.providerId}` : "";
  const matched = candidate.matchedSession ? " · exact session" : "";
  return `${index + 1}. ${shortPath(candidate.workspacePath)}${anchor}${provider}${matched}`;
}

function safeSessionEntries(ctx: SessionLike): unknown[] {
  try {
    return ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
  } catch {
    return [];
  }
}

function resolveUserPath(path: string, cwd: string): string {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function shortPath(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function ensureDaemon(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const configured = process.env.DIFFECT_URL?.trim();
  if (configured) {
    const url = configured.replace(/\/$/, "");
    if (await isDiffectd(url, signal)) return url;
    throw new Error(`DIFFECT_URL is not a ready Diffect UI/API service: ${configured}`);
  }

  const launcher = await resolveDesktopLauncher(pi, cwd, signal);
  const result = await pi.exec(
    launcher.command,
    [...launcher.args, "daemon", "ensure", "--json"],
    { cwd: homedir(), signal, timeout: 30_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `Diffect launcher exited ${result.code}`,
    );
  }
  return parseManagedEnsureOutput(result.stdout);
}

export function parseManagedEnsureOutput(stdout: string): string {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Diffect launcher returned invalid JSON");
  }
  const daemon = isRecord(value) && isRecord(value.daemon) ? value.daemon : null;
  if (
    !daemon ||
    daemon.service !== "diffect" ||
    daemon.origin !== CANONICAL_LOCAL_ORIGIN ||
    daemon.lifecycle !== "ready" ||
    daemon.web !== true ||
    typeof daemon.version !== "string" ||
    typeof daemon.buildId !== "string" ||
    typeof daemon.instanceId !== "string"
  ) {
    throw new Error("Diffect launcher did not return the ready canonical UI/API service");
  }
  return CANONICAL_LOCAL_ORIGIN;
}

async function isDiffectd(baseUrl: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { accept: "application/json" },
      signal,
    });
    if (!res.ok) return false;
    const health = (await res.json()) as Record<string, unknown>;
    return health.service === "diffect" && health.lifecycle === "ready" && health.web === true;
  } catch {
    return false;
  }
}

async function registerWorkspace(baseUrl: string, workspaceRoot: string, signal?: AbortSignal) {
  const res = await fetch(`${baseUrl}/workspaces?summary=0`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: workspaceRoot }),
    signal,
  });
  if (!res.ok) throw new Error(await responseError(res));
}

async function locateRepo(
  baseUrl: string,
  workspaceRoot: string,
  anchorRoot: string | null,
  signal?: AbortSignal,
): Promise<RepoLocation> {
  const res = await fetch(`${baseUrl}/workspaces`, { signal });
  if (!res.ok) throw new Error(await responseError(res));
  const entries = (await res.json()) as Array<{
    path: string;
    repos?: Array<{ name: string; root: string; worktrees?: Array<{ name: string; root: string }> }>;
  }>;
  const wantedWorkspace = real(workspaceRoot);
  const entry = entries.find((e) => real(e.path) === wantedWorkspace);
  const repos = entry?.repos ?? [];
  if (anchorRoot) {
    const wanted = real(anchorRoot);
    for (const repo of repos) {
      if (real(repo.root) === wanted) return { repo: repo.name, worktree: null };
      for (const wt of repo.worktrees ?? []) {
        if (real(wt.root) === wanted) return { repo: repo.name, worktree: wt.name };
      }
    }
  }
  const first = repos[0];
  if (first) return { repo: first.name, worktree: null };
  throw new Error(`diffectd does not list workspace ${workspaceRoot}`);
}

async function runDiffectTool(
  pi: ExtensionAPI,
  ctx: CwdContext,
  args: string[],
  signal?: AbortSignal,
  explicitWorkspace?: string,
) {
  const { workspaceRoot } = await resolveReviewWorkspace(pi, ctx, explicitWorkspace, signal);
  const cli = await findCli(pi, workspaceRoot, signal);
  const r = await pi.exec(cli.command, [...cli.args, ...args], {
    cwd: workspaceRoot,
    signal,
    timeout: 30_000,
  });
  if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || `diffect exited ${r.code}`);
  return textResult(truncate(r.stdout.trim() || "{}"), { stdout: r.stdout, stderr: r.stderr, code: r.code });
}

function filterFeedbackResult(
  result: ReturnType<typeof textResult>,
  ids: string[],
): ReturnType<typeof textResult> {
  const details = isRecord(result.details) ? result.details : {};
  const stdout = typeof details.stdout === "string" ? details.stdout : "";
  const output = filterFeedbackJson(stdout, ids);
  return textResult(truncate(output), { ...details, stdout: output });
}

async function findCli(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<Command> {
  const local = findLocalFile(
    "packages/core/dist/cli.js",
    fileURLToPath(import.meta.url),
  );
  if (local) return nodeCommand(local);
  const pathCli = await pathCommand(pi, "diffect", cwd, signal);
  if (pathCli) return { command: pathCli, args: [] };
  throw new Error("diffect CLI not found. Build Diffect or put `diffect` on PATH.");
}

export async function resolveDesktopLauncher(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<Command> {
  const explicit = process.env.DIFFECT_APP_PATH?.trim();
  if (explicit) {
    if (!isAbsolute(explicit) || !existsSync(explicit)) {
      throw new Error("DIFFECT_APP_PATH must name an absolute Diffect desktop executable");
    }
    return { command: realpathSync(explicit), args: [] };
  }

  const pathLauncher = await pathCommand(pi, "diffect-desktop", cwd, signal);
  if (pathLauncher) return { command: pathLauncher, args: [] };

  const recorded = await readInstalledLauncher();
  if (recorded) return { command: recorded, args: [] };
  throw new Error(
    "Diffect desktop launcher not found. Set DIFFECT_APP_PATH, put diffect-desktop on PATH, or launch the installed app once.",
  );
}

async function readInstalledLauncher(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(installationPath(), "utf8")) as {
      launcherPath?: unknown;
    };
    if (typeof parsed.launcherPath !== "string" || !isAbsolute(parsed.launcherPath)) {
      return null;
    }
    return existsSync(parsed.launcherPath) ? realpathSync(parsed.launcherPath) : null;
  } catch {
    return null;
  }
}

async function pathCommand(
  pi: ExtensionAPI,
  name: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const lookupDirectory = homedir();
  const r = await pi.exec("bash", ["-lc", `command -v ${name}`], {
    cwd: lookupDirectory,
    signal,
    timeout: 5_000,
  });
  if (r.code !== 0 || !r.stdout.trim()) return null;
  return resolveTrustedCommand(
    r.stdout.trim(),
    lookupDirectory,
    commandTrustRoot(cwd),
  );
}

function commandTrustRoot(cwd: string): string {
  const start = real(cwd);
  let directory = start;
  while (true) {
    if (existsSync(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return start;
    directory = parent;
  }
}

function nodeCommand(file: string): Command {
  // pi itself may be a Bun/SEA executable; use the user's Node for JS files.
  return file.endsWith(".ts")
    ? { command: "node", args: ["--experimental-strip-types", file] }
    : { command: "node", args: [file] };
}

function installationPath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "diffect", "installation.json");
}

async function openDiffectApp(
  pi: ExtensionAPI,
  cwd: string,
  url?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const args = url ? [url] : [];
  const launcher = await resolveDesktopLauncher(pi, cwd, signal).catch(() => null);
  if (launcher && spawnDetached(launcher.command, [...launcher.args, ...args], cwd)) {
    return true;
  }

  if (process.platform === "darwin") {
    for (const openArgs of diffectAppOpenArgs(url)) {
      const r = await pi.exec("open", openArgs, { cwd, signal, timeout: 5_000 });
      if (r.code === 0) return true;
    }
  }

  return false;
}

async function openUrl(
  pi: ExtensionAPI,
  cwd: string,
  url: string,
  signal?: AbortSignal,
): Promise<void> {
  if (await openDiffectApp(pi, cwd, url, signal)) return;

  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // URL is still returned/notified; remote shells often have no opener.
  }
}

function spawnDetached(command: string, args: string[], cwd: string): boolean {
  try {
    spawn(command, args, { cwd, detached: true, stdio: "ignore", env: process.env }).unref();
    return true;
  } catch {
    return false;
  }
}

function diffectAppOpenArgs(url?: string): string[][] {
  const suffix = url ? ["--args", url] : [];
  const app = process.env.DIFFECT_APP?.trim();
  return [
    ...(app ? [["-a", app, ...suffix]] : []),
    ["-b", "app.diffect.desktop", ...suffix],
    ["-a", "Diffect", ...suffix],
  ];
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

async function responseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT
    ? `${text.slice(0, MAX_OUTPUT)}\n\n[truncated at ${MAX_OUTPUT} bytes]`
    : text;
}

function textResult(text: string, details: unknown) {
  return { content: [{ type: "text", text }], details };
}
