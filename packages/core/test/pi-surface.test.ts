import { describe, expect, it } from "vitest";
import diffectExtension from "../../../integrations/pi/diffect.js";

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
}

function schemaShape(parameters: unknown) {
  const schema = parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    properties: Object.keys(schema.properties ?? {}),
    required: schema.required ?? [],
  };
}

describe("Pi integration surface", () => {
  it("keeps the current commands, tools, schemas, prompts, and lifecycle hooks registered", () => {
    const commands: Array<{ name: string; description: string }> = [];
    const tools: RegisteredTool[] = [];
    const events: string[] = [];
    const pi = {
      on(event: string) {
        events.push(event);
      },
      registerCommand(
        name: string,
        command: { description: string },
      ) {
        commands.push({ name, description: command.description });
      },
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
    } as unknown as Parameters<typeof diffectExtension>[0];

    diffectExtension(pi);

    expect(events).toEqual([
      "session_start",
      "agent_settled",
      "session_shutdown",
    ]);
    expect(commands).toEqual([
      {
        name: "diffect-connect",
        description: "Watch this Pi session's Diffect feedback",
      },
      {
        name: "diffect-disconnect",
        description: "Stop watching Diffect feedback",
      },
      { name: "diffect", description: "Open the current Diffect workspace" },
      {
        name: "diffect-space",
        description: "Choose this session's Diffect workspace",
      },
      {
        name: "diffect-review",
        description: "Ask the agent to review Diffect feedback",
      },
    ]);
    expect(
      tools.map((tool) => ({
        name: tool.name,
        label: tool.label,
        promptSnippet: tool.promptSnippet ?? null,
        promptGuidelines: tool.promptGuidelines ?? [],
        ...schemaShape(tool.parameters),
      })),
    ).toEqual([
      {
        name: "diffect_open",
        label: "Diffect Open",
        promptSnippet: "Open the current workspace in Diffect's local review UI",
        promptGuidelines: [],
        properties: ["target", "workspace", "open"],
        required: [],
      },
      {
        name: "diffect_list_feedback",
        label: "Diffect Feedback",
        promptSnippet: "List open Diffect review feedback before making review fixes",
        promptGuidelines: [
          "Use diffect_list_feedback when the user asks to address Diffect review feedback, comments, or threads.",
        ],
        properties: ["status", "ids", "repo", "worktree", "workspace"],
        required: [],
      },
      {
        name: "diffect_reply",
        label: "Diffect Reply",
        promptSnippet: null,
        promptGuidelines: [],
        properties: ["id", "body", "agent", "workspace"],
        required: ["id", "body"],
      },
      {
        name: "diffect_resolve",
        label: "Diffect Resolve",
        promptSnippet: null,
        promptGuidelines: [],
        properties: ["id", "summary", "agent", "workspace"],
        required: ["id", "summary"],
      },
      {
        name: "diffect_pr",
        label: "Diffect PR",
        promptSnippet: "Get or update Diffect's local PR Draft title/body",
        promptGuidelines: [],
        properties: ["action", "title", "body", "repo", "worktree", "workspace"],
        required: [],
      },
      {
        name: "diffect_comment",
        label: "Diffect Comment",
        promptSnippet: "Create a Diffect review comment on a file line/range",
        promptGuidelines: ["Use diffect_comment for proactive Diffect review comments."],
        properties: [
          "file",
          "line",
          "endLine",
          "side",
          "severity",
          "target",
          "repo",
          "worktree",
          "workspace",
          "body",
          "agent",
        ],
        required: ["file", "line", "body"],
      },
    ]);
    expect(tools.every(({ description }) => description.length > 0)).toBe(true);
  });
});
