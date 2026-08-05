import { describe, expect, it } from "vitest";
import diffectExtension from "../../../integrations/pi/diffect.js";

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute?: unknown;
}

describe("Pi integration surface", () => {
  it("keeps the current commands, tools, schemas, prompts, and lifecycle hooks registered", () => {
    const commands: Array<{ name: string; description: string }> = [];
    const tools: Array<Omit<RegisteredTool, "execute">> = [];
    const executableTools: string[] = [];
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
        const { execute, ...surface } = tool;
        if (typeof execute === "function") executableTools.push(tool.name);
        tools.push(surface);
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
    expect(executableTools).toEqual(tools.map(({ name }) => name));
    expect(tools).toMatchInlineSnapshot(`
      [
        {
          "description": "Start/reuse diffectd and return the current workspace's Diffect URL.",
          "label": "Diffect Open",
          "name": "diffect_open",
          "parameters": {
            "properties": {
              "open": {
                "description": "Also ask the OS to open the URL",
                "type": "boolean",
              },
              "target": {
                "description": "Review target, default: work",
                "type": "string",
              },
              "workspace": {
                "description": "Workspace/space path; inferred when omitted",
                "type": "string",
              },
            },
            "type": "object",
          },
          "promptSnippet": "Open the current workspace in Diffect's local review UI",
        },
        {
          "description": "List Diffect review feedback as JSON using the local store.",
          "label": "Diffect Feedback",
          "name": "diffect_list_feedback",
          "parameters": {
            "properties": {
              "ids": {
                "description": "Return only these thread ids",
                "items": {
                  "type": "string",
                },
                "type": "array",
              },
              "repo": {
                "type": "string",
              },
              "status": {
                "description": "open, closed, or all; default: open",
                "type": "string",
              },
              "workspace": {
                "description": "Workspace/space path; inferred when omitted",
                "type": "string",
              },
              "worktree": {
                "type": "string",
              },
            },
            "type": "object",
          },
          "promptGuidelines": [
            "Use diffect_list_feedback when the user asks to address Diffect review feedback, comments, or threads.",
          ],
          "promptSnippet": "List open Diffect review feedback before making review fixes",
        },
        {
          "description": "Reply to a Diffect review thread/comment as an agent.",
          "label": "Diffect Reply",
          "name": "diffect_reply",
          "parameters": {
            "properties": {
              "agent": {
                "description": "Agent author name; defaults to this Pi session",
                "type": "string",
              },
              "body": {
                "description": "Reply body",
                "type": "string",
              },
              "id": {
                "description": "Diffect thread id",
                "type": "string",
              },
              "workspace": {
                "description": "Workspace/space path; inferred when omitted",
                "type": "string",
              },
            },
            "required": [
              "id",
              "body",
            ],
            "type": "object",
          },
        },
        {
          "description": "Resolve a Diffect review thread/comment as an agent.",
          "label": "Diffect Resolve",
          "name": "diffect_resolve",
          "parameters": {
            "properties": {
              "agent": {
                "description": "Agent author name; defaults to this Pi session",
                "type": "string",
              },
              "id": {
                "description": "Diffect thread id",
                "type": "string",
              },
              "summary": {
                "description": "What changed / why it is resolved",
                "type": "string",
              },
              "workspace": {
                "description": "Workspace/space path; inferred when omitted",
                "type": "string",
              },
            },
            "required": [
              "id",
              "summary",
            ],
            "type": "object",
          },
        },
        {
          "description": "Get or update the local PR Draft packet for a Diffect repo.",
          "label": "Diffect PR",
          "name": "diffect_pr",
          "parameters": {
            "properties": {
              "action": {
                "description": "get, update, or copy_body; default get",
                "type": "string",
              },
              "body": {
                "type": "string",
              },
              "repo": {
                "description": "Repo name; required when the workspace has multiple repos",
                "type": "string",
              },
              "title": {
                "type": "string",
              },
              "workspace": {
                "description": "Workspace/space path; inferred when omitted",
                "type": "string",
              },
              "worktree": {
                "description": "Worktree name",
                "type": "string",
              },
            },
            "type": "object",
          },
          "promptSnippet": "Get or update Diffect's local PR Draft title/body",
        },
        {
          "description": "Create a Diffect review comment on a file line/range as an agent.",
          "label": "Diffect Comment",
          "name": "diffect_comment",
          "parameters": {
            "properties": {
              "agent": {
                "description": "Agent author name; defaults to this Pi session",
                "type": "string",
              },
              "body": {
                "type": "string",
              },
              "endLine": {
                "type": "number",
              },
              "file": {
                "type": "string",
              },
              "line": {
                "type": "number",
              },
              "repo": {
                "type": "string",
              },
              "severity": {
                "description": "must-fix, suggestion, nit, or question",
                "type": "string",
              },
              "side": {
                "description": "new or old; default: new",
                "type": "string",
              },
              "target": {
                "description": "Review target, default: work",
                "type": "string",
              },
              "workspace": {
                "description": "Workspace/space path; inferred when omitted",
                "type": "string",
              },
              "worktree": {
                "type": "string",
              },
            },
            "required": [
              "file",
              "line",
              "body",
            ],
            "type": "object",
          },
          "promptGuidelines": [
            "Use diffect_comment for proactive Diffect review comments.",
          ],
          "promptSnippet": "Create a Diffect review comment on a file line/range",
        },
      ]
    `);
  });
});
