import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import diffectExtension from "../../../integrations/pi/diffect.js";

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
}

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "diffect-pi-review-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

it("reads exactly one Review ID without workspace or daemon resolution", async () => {
  const tools = new Map<string, RegisteredTool>();
  const calls: Array<{ command: string; args: string[] }> = [];
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    async exec(command: string, args: string[]) {
      calls.push({ command, args });
      if (command === "bash") {
        return { code: 0, stdout: "/usr/bin/true\n", stderr: "" };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ review: { id: reviewId, threads: [] } }),
        stderr: "",
      };
    },
  };
  const reviewId = `rvw_${"a".repeat(32)}`;
  diffectExtension(pi as any);

  const tool = tools.get("diffect_list_feedback");
  expect(tool).toBeDefined();
  const result = await tool!.execute(
    "call-id",
    { reviewId },
    undefined,
    undefined,
    { cwd },
  );

  const execution = calls.at(-1)!;
  expect(execution.args.slice(-4)).toEqual([
    "review",
    "show",
    reviewId,
    "--json",
  ]);
  expect(calls.every((call) => !call.args.some((arg) => arg.includes("list")))).toBe(
    true,
  );
  expect(result.content[0].text).toContain(reviewId);
});

it("rejects legacy or malformed IDs before invoking a command", async () => {
  const tools = new Map<string, RegisteredTool>();
  let executions = 0;
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    async exec() {
      executions += 1;
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  diffectExtension(pi as any);

  await expect(
    tools.get("diffect_list_feedback")!.execute(
      "call-id",
      { reviewId: "sess_legacy" },
      undefined,
      undefined,
      { cwd },
    ),
  ).rejects.toThrow(/opaque rvw_/);
  expect(executions).toBe(0);
});
