import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProviderCommandError,
  providerCommandEnvironment,
  runProviderCommand,
  type ProviderCommandRunner,
} from "../src/workspace-providers/command.js";
import {
  discoverCmuxWorkspaces,
  parseCmuxCurrentWorkspace,
  parseCmuxSessions,
  parseCmuxTree,
} from "../src/workspace-providers/cmux.js";
import {
  discoverHerdrWorkspaces,
  parseHerdrCurrentPane,
  parseHerdrPaneList,
} from "../src/workspace-providers/herdr.js";

const fixtureRoot = new URL("./fixtures/workspace-providers/", import.meta.url);

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, fixtureRoot), "utf8");
}

describe("native provider command runner", () => {
  it("passes argv without invoking a shell", async () => {
    const marker = "value; echo should-not-run";
    const result = await runProviderCommand(process.execPath, [
      "-e",
      "process.stdout.write(process.argv[1])",
      marker,
    ]);

    expect(result.stdout).toBe(marker);
  });

  it("bounds execution time and output", async () => {
    await expect(
      runProviderCommand(
        process.execPath,
        ["-e", "setTimeout(() => {}, 1000)"],
        { timeoutMs: 10 },
      ),
    ).rejects.toMatchObject({ kind: "timeout" });

    await expect(
      runProviderCommand(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(10000))"],
        { maxOutputBytes: 64 },
      ),
    ).rejects.toMatchObject({ kind: "output-limit" });
  });

  it("supports cancellation", async () => {
    const controller = new AbortController();
    const pending = runProviderCommand(
      process.execPath,
      ["-e", "setTimeout(() => {}, 1000)"],
      { signal: controller.signal },
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("removes provider context while preserving named native credentials", () => {
    const env = providerCommandEnvironment(
      "CMUX_",
      ["CMUX_SOCKET_PASSWORD"],
      {
        PATH: "/usr/bin",
        CMUX_SOCKET_PATH: "/tmp/context.sock",
        CMUX_SOCKET_PASSWORD: "provider-owned-secret",
      },
    );

    expect(env).toEqual({
      PATH: "/usr/bin",
      CMUX_SOCKET_PASSWORD: "provider-owned-secret",
    });
  });
});

describe("Herdr provider", () => {
  it("parses representative pane output", async () => {
    const panes = parseHerdrPaneList(await fixture("herdr-pane-list.json"));
    const current = parseHerdrCurrentPane(
      await fixture("herdr-pane-current.json"),
    );

    expect(panes).toHaveLength(3);
    expect(panes[0]).toMatchObject({
      workspaceId: "workspace-a",
      foregroundCwd: "/work/ticket/repo-a",
      agentSession: {
        agent: "pi",
        kind: "path",
        value: "/sessions/pi/session.jsonl",
      },
    });
    expect(current.workspaceId).toBe("workspace-a");
  });

  it("matches the caller session before focused workspace state", async () => {
    const calls: string[][] = [];
    const list = await fixture("herdr-pane-list.json");
    const run: ProviderCommandRunner = async (_command, args, options) => {
      calls.push([...args]);
      expect(Object.keys(options?.env ?? {})).not.toContain("HERDR_WORKSPACE_ID");
      return { stdout: list, stderr: "" };
    };

    const results = await discoverHerdrWorkspaces(
      {
        id: "herdr-local",
        kind: "herdr",
        enabled: true,
        command: "herdr-bin",
        session: "named",
      },
      {
        agentSession: {
          provider: "pi",
          path: "/sessions/pi/session.jsonl",
        },
      },
      run,
    );

    expect(calls).toEqual([["--session", "named", "pane", "list"]]);
    expect(results).toEqual([
      {
        providerId: "herdr-local",
        externalWorkspaceId: "workspace-a",
        candidatePaths: ["/work/ticket/repo-a", "/work/ticket"],
        matchedSession: true,
        status: "available",
      },
    ]);
    expect(results[0]?.candidatePaths).not.toContain("/work/ticket/repo-b");
    expect(results[0]?.candidatePaths).not.toContain("/work");
  });

  it("returns separate matches when one agent session appears in multiple workspaces", async () => {
    const payload = JSON.parse(await fixture("herdr-pane-list.json")) as {
      result: { panes: Record<string, unknown>[] };
    };
    payload.result.panes.push({
      ...payload.result.panes[0]!,
      pane_id: "workspace-c:p1",
      workspace_id: "workspace-c",
      cwd: "/work/other",
      foreground_cwd: "/work/other/repo",
    });

    const results = await discoverHerdrWorkspaces(
      { id: "herdr", kind: "herdr", enabled: true, command: "herdr" },
      {
        agentSession: {
          provider: "pi",
          path: "/sessions/pi/session.jsonl",
        },
      },
      async () => ({ stdout: JSON.stringify(payload), stderr: "" }),
    );

    expect(results.map((result) => result.externalWorkspaceId)).toEqual([
      "workspace-a",
      "workspace-c",
    ]);
  });

  it("falls back to focused pane paths and reports native failures", async () => {
    const current = await fixture("herdr-pane-current.json");
    const list = await fixture("herdr-pane-list.json");
    const calls: string[][] = [];
    const run: ProviderCommandRunner = async (_command, args) => {
      calls.push([...args]);
      return {
        stdout: args.includes("current") ? current : list,
        stderr: "",
      };
    };

    const results = await discoverHerdrWorkspaces(
      { id: "herdr", kind: "herdr", enabled: true, command: "herdr" },
      {},
      run,
    );
    expect(calls[0]).toEqual(["pane", "current"]);
    expect(results.at(-1)).toMatchObject({
      externalWorkspaceId: "workspace-a",
      candidatePaths: [
        "/work/ticket/repo-a",
        "/work/ticket",
        "/work/ticket/repo-b",
      ],
      matchedSession: false,
      status: "available",
    });

    const malformed = await discoverHerdrWorkspaces(
      { id: "herdr", kind: "herdr", enabled: true, command: "herdr" },
      {},
      async () => ({ stdout: "not-json", stderr: "" }),
    );
    expect(malformed).toEqual([
      expect.objectContaining({ status: "error", message: expect.stringContaining("valid JSON") }),
    ]);

    const unavailable = await discoverHerdrWorkspaces(
      { id: "herdr", kind: "herdr", enabled: true, command: "missing-herdr" },
      {},
      async () => {
        throw new ProviderCommandError("unavailable", "missing-herdr was not found");
      },
    );
    expect(unavailable).toEqual([
      expect.objectContaining({ status: "unavailable" }),
    ]);
  });
});

describe("cmux provider", () => {
  it("parses representative session, tree, and current-workspace output", async () => {
    const sessions = parseCmuxSessions(await fixture("cmux-sessions.json"));
    const tree = parseCmuxTree(await fixture("cmux-tree.json"));
    const current = parseCmuxCurrentWorkspace(
      await fixture("cmux-current-workspace.json"),
    );

    expect(sessions.totalMatches).toBe(1);
    expect(sessions.sessions[0]).toMatchObject({
      agent: "pi",
      sessionId: "session-1",
      workspaceId: "00000000-0000-0000-0000-000000000001",
      surfaceId: "00000000-0000-0000-0000-000000000011",
      cwd: "/work/ticket/repo-a",
    });
    expect(tree.map((workspace) => workspace.title)).toEqual([
      "Ticket workspace",
      "Focused workspace",
    ]);
    expect(current).toEqual({
      id: "00000000-0000-0000-0000-000000000002",
      title: "Focused workspace",
      currentDirectory: "/work/focused/repo",
    });
  });

  it("prefers exact agent-session metadata over the focused workspace", async () => {
    const sessions = await fixture("cmux-sessions.json");
    const tree = await fixture("cmux-tree.json");
    const calls: string[][] = [];
    const run: ProviderCommandRunner = async (command, args, options) => {
      expect(basename(command)).toBe("cmux-bin");
      expect(Object.keys(options?.env ?? {})).not.toContain("CMUX_WORKSPACE_ID");
      calls.push([...args]);
      return {
        stdout: args.includes("sessions") ? sessions : tree,
        stderr: "",
      };
    };

    const results = await discoverCmuxWorkspaces(
      {
        id: "cmux-local",
        kind: "cmux",
        enabled: true,
        command: "/tools/cmux-bin",
        socketPath: "/state/cmux.sock",
      },
      { agentSession: { provider: "pi", id: "session-1" } },
      run,
    );

    expect(calls).toEqual([
      [
        "--socket",
        "/state/cmux.sock",
        "--json",
        "sessions",
        "list",
        "--agent",
        "pi",
        "--session",
        "session-1",
        "--all",
        "--limit",
        "20",
      ],
      ["--socket", "/state/cmux.sock", "--json", "tree", "--all"],
    ]);
    expect(results.at(-1)).toEqual({
      providerId: "cmux-local",
      externalWorkspaceId: "00000000-0000-0000-0000-000000000001",
      label: "Ticket workspace",
      candidatePaths: ["/work/ticket/repo-a", "/work/ticket"],
      matchedSession: true,
      status: "available",
    });
  });

  it("matches an exact session by transcript path when no ID is available", async () => {
    const sessions = await fixture("cmux-sessions.json");
    const tree = await fixture("cmux-tree.json");
    const calls: string[][] = [];

    const results = await discoverCmuxWorkspaces(
      { id: "cmux", kind: "cmux", enabled: true, command: "cmux" },
      {
        agentSession: {
          provider: "pi",
          path: "/sessions/pi/session.jsonl",
        },
      },
      async (_command, args) => {
        calls.push([...args]);
        return {
          stdout: args.includes("sessions") ? sessions : tree,
          stderr: "",
        };
      },
    );

    expect(calls).toEqual([
      [
        "--json",
        "sessions",
        "list",
        "--agent",
        "pi",
        "--all",
        "--limit",
        "20",
      ],
      ["--json", "tree", "--all"],
    ]);
    expect(results.at(-1)).toMatchObject({
      externalWorkspaceId: "00000000-0000-0000-0000-000000000001",
      matchedSession: true,
      status: "available",
    });
  });

  it("keeps multiple exact session workspaces ambiguous", async () => {
    const payload = JSON.parse(await fixture("cmux-sessions.json")) as {
      total_matches: number;
      sessions: Record<string, unknown>[];
    };
    payload.total_matches = 2;
    payload.sessions.push({
      ...payload.sessions[0]!,
      workspace_id: "00000000-0000-0000-0000-000000000003",
      surface_id: "00000000-0000-0000-0000-000000000033",
      cwd: "/work/other/repo",
    });
    const tree = JSON.parse(await fixture("cmux-tree.json")) as {
      windows: { workspaces: Record<string, unknown>[] }[];
    };
    tree.windows[0]!.workspaces.push({
      id: "00000000-0000-0000-0000-000000000003",
      title: "Other workspace",
      panes: [
        {
          surfaces: [
            { id: "00000000-0000-0000-0000-000000000033" },
          ],
        },
      ],
    });

    const results = await discoverCmuxWorkspaces(
      { id: "cmux", kind: "cmux", enabled: true, command: "cmux" },
      { agentSession: { provider: "pi", id: "session-1" } },
      async (_command, args) => ({
        stdout: args.includes("sessions")
          ? JSON.stringify(payload)
          : JSON.stringify(tree),
        stderr: "",
      }),
    );

    expect(results.filter((result) => result.status === "available")).toHaveLength(2);
    expect(results.map((result) => result.externalWorkspaceId)).toEqual([
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000003",
    ]);
  });

  it("rejects stale saved sessions and falls back to the live current workspace", async () => {
    const sessions = await fixture("cmux-sessions.json");
    const tree = JSON.parse(await fixture("cmux-tree.json")) as {
      windows: { workspaces: { panes: { surfaces: { id: string }[] }[] }[] }[];
    };
    tree.windows[0]!.workspaces[0]!.panes[0]!.surfaces[0]!.id =
      "00000000-0000-0000-0000-000000000099";
    const current = await fixture("cmux-current-workspace.json");

    const results = await discoverCmuxWorkspaces(
      { id: "cmux", kind: "cmux", enabled: true, command: "cmux" },
      { agentSession: { provider: "pi", id: "session-1" } },
      async (_command, args) => ({
        stdout: args.includes("sessions")
          ? sessions
          : args.includes("tree")
            ? JSON.stringify(tree)
            : current,
        stderr: "",
      }),
    );

    expect(results[0]).toMatchObject({
      status: "unavailable",
      message: "saved cmux session metadata did not match a live surface",
    });
    expect(results.at(-1)).toMatchObject({
      externalWorkspaceId: "00000000-0000-0000-0000-000000000002",
      matchedSession: false,
      status: "available",
    });
  });

  it("does not select partial session results or saved metadata without a live tree", async () => {
    const partial = JSON.parse(await fixture("cmux-sessions.json")) as {
      total_matches: number;
    };
    partial.total_matches = 21;
    const current = await fixture("cmux-current-workspace.json");
    const partialCalls: string[][] = [];

    const partialResults = await discoverCmuxWorkspaces(
      { id: "cmux", kind: "cmux", enabled: true, command: "cmux" },
      { agentSession: { provider: "pi", id: "session-1" } },
      async (_command, args) => {
        partialCalls.push([...args]);
        return {
          stdout: args.includes("sessions") ? JSON.stringify(partial) : current,
          stderr: "",
        };
      },
    );
    expect(partialCalls.some((args) => args.includes("tree"))).toBe(false);
    expect(partialResults[0]).toMatchObject({
      status: "unavailable",
      message: expect.stringContaining("1 of 21"),
    });
    expect(partialResults.at(-1)).toMatchObject({ matchedSession: false });

    const sessions = await fixture("cmux-sessions.json");
    const treeFailureResults = await discoverCmuxWorkspaces(
      { id: "cmux", kind: "cmux", enabled: true, command: "cmux" },
      { agentSession: { provider: "pi", id: "session-1" } },
      async (_command, args) => {
        if (args.includes("sessions")) return { stdout: sessions, stderr: "" };
        if (args.includes("tree")) {
          throw new ProviderCommandError("failed", "cmux tree failed");
        }
        return { stdout: current, stderr: "" };
      },
    );
    expect(treeFailureResults[0]).toMatchObject({
      status: "error",
      message: "cmux tree failed",
    });
    expect(treeFailureResults.at(-1)).toMatchObject({ matchedSession: false });
  });

  it("uses the explicitly reported current workspace when no session matches", async () => {
    const current = await fixture("cmux-current-workspace.json");
    const results = await discoverCmuxWorkspaces(
      { id: "cmux", kind: "cmux", enabled: true, command: "cmux" },
      {},
      async (_command, args) => {
        expect(args).toEqual(["--json", "current-workspace"]);
        return { stdout: current, stderr: "" };
      },
    );

    expect(results).toEqual([
      {
        providerId: "cmux",
        externalWorkspaceId: "00000000-0000-0000-0000-000000000002",
        label: "Focused workspace",
        candidatePaths: ["/work/focused/repo"],
        matchedSession: false,
        status: "available",
      },
    ]);
  });

  it("reports unavailable sockets and incompatible output without throwing", async () => {
    const unavailable = await discoverCmuxWorkspaces(
      { id: "cmux", kind: "cmux", enabled: true, command: "cmux" },
      {},
      async () => {
        throw new ProviderCommandError(
          "failed",
          "cmux failed: Error: Socket not found at /state/cmux.sock",
        );
      },
    );
    expect(unavailable).toEqual([
      expect.objectContaining({ status: "unavailable" }),
    ]);

    const incompatible = await discoverCmuxWorkspaces(
      { id: "cmux", kind: "cmux", enabled: true, command: "cmux" },
      {},
      async () => ({ stdout: JSON.stringify({ workspace_id: "only-an-id" }), stderr: "" }),
    );
    expect(incompatible).toEqual([
      expect.objectContaining({
        status: "error",
        message: expect.stringContaining("current workspace summary"),
      }),
    ]);

    const timedOut = await discoverCmuxWorkspaces(
      { id: "cmux", kind: "cmux", enabled: true, command: "cmux" },
      {},
      async () => {
        throw new ProviderCommandError("timeout", "cmux timed out after 1500ms");
      },
    );
    expect(timedOut).toEqual([
      expect.objectContaining({ status: "error", message: expect.stringContaining("timed out") }),
    ]);
  });
});
