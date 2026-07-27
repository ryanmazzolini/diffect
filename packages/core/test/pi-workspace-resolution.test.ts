import { describe, expect, it } from "vitest";
import { parseSettings } from "../src/store/settings.js";
import {
  buildPiWorkspaceResolutionRequest,
  daemonWorkspaceArguments,
  decideWorkspaceCandidate,
  parseWorkspaceResolutionResponse,
  settingsWithWorkspaceBinding,
} from "../../../integrations/pi/workspace-resolution.js";

describe("Pi workspace resolution client", () => {
  it("builds caller context from stable Pi session metadata", () => {
    expect(
      buildPiWorkspaceResolutionRequest(
        {
          cwd: "/work/ticket/diffect",
          sessionId: "session-1",
          sessionFile: "/sessions/pi/session.jsonl",
          sessionCwd: "/work/ticket",
        },
        "/explicit/workspace",
      ),
    ).toEqual({
      explicitWorkspace: "/explicit/workspace",
      cwd: "/work/ticket/diffect",
      agentSession: {
        provider: "pi",
        id: "session-1",
        path: "/sessions/pi/session.jsonl",
        cwd: "/work/ticket",
      },
    });
  });

  it("falls back to the extension cwd for an in-memory Pi session", () => {
    expect(
      buildPiWorkspaceResolutionRequest({ cwd: "/work/repo" }),
    ).toEqual({
      cwd: "/work/repo",
      agentSession: { provider: "pi", cwd: "/work/repo" },
    });
  });

  it("validates selected and ambiguous daemon responses", () => {
    const selected = candidate("/work/selected", "pi", "project-1");
    const alternative = candidate("/work/other", "pi", "project-2");
    const response = parseWorkspaceResolutionResponse({
      selected,
      candidates: [selected],
      results: [
        {
          providerId: "pi",
          status: "available",
          candidatePaths: ["/work/selected"],
          matchedSession: true,
        },
      ],
    });

    expect(decideWorkspaceCandidate(response)).toEqual(selected);
    expect(
      decideWorkspaceCandidate(response, {
        forcePicker: true,
        interactive: true,
      }),
    ).toBeNull();
    const ambiguous = {
      ...response,
      selected: null,
      candidates: [selected, alternative],
    };
    expect(
      decideWorkspaceCandidate(ambiguous, { interactive: true }),
    ).toBeNull();
    expect(() => decideWorkspaceCandidate(ambiguous)).toThrow(
      "Run /diffect-space",
    );
    expect(() =>
      decideWorkspaceCandidate({
        selected: null,
        candidates: [],
        results: [
          {
            providerId: "herdr",
            status: "unavailable",
            message: "Herdr is not running",
          },
        ],
      }),
    ).toThrow("Herdr is not running");
    expect(() =>
      parseWorkspaceResolutionResponse({
        selected: { ...selected, workspacePath: "relative" },
        candidates: [],
        results: [],
      }),
    ).toThrow("invalid workspace resolution");
  });

  it("atomically replaces one external-workspace binding", () => {
    const settings = {
      version: 1,
      workspaceResolution: {
        providers: [
          {
            id: "pi",
            kind: "pi-session",
            enabled: true,
            sessionsPath: "/sessions/pi",
          },
        ],
        bindings: [
          {
            providerId: "pi",
            externalWorkspaceId: "project-1",
            diffectWorkspacePath: "/work/old",
          },
          {
            providerId: "pi",
            externalWorkspaceId: "project-2",
            diffectWorkspacePath: "/work/other",
          },
        ],
      },
    };
    const selected = candidate("/work/new", "pi", "project-1");
    const update = settingsWithWorkspaceBinding(settings, selected);

    expect(update?.changed).toBe(true);
    if (!update) throw new Error("expected a settings binding update");
    expect(update.document).toEqual({
      ...settings,
      workspaceResolution: {
        ...settings.workspaceResolution,
        bindings: [
          settings.workspaceResolution.bindings[1],
          {
            providerId: "pi",
            externalWorkspaceId: "project-1",
            diffectWorkspacePath: "/work/new",
          },
        ],
      },
    });
    expect(parseSettings(update.document).workspaceResolution.bindings).toEqual([
      settings.workspaceResolution.bindings[1],
      {
        providerId: "pi",
        externalWorkspaceId: "project-1",
        diffectWorkspacePath: "/work/new",
      },
    ]);
    expect(
      settingsWithWorkspaceBinding(update.document, selected)?.changed,
    ).toBe(false);
    expect(
      settingsWithWorkspaceBinding(settings, {
        ...selected,
        providerId: null,
        externalWorkspaceId: undefined,
      }),
    ).toBeNull();
  });

  it("starts an unseeded daemon before resolution", () => {
    expect(daemonWorkspaceArguments()).toEqual(["--no-workspace"]);
    expect(daemonWorkspaceArguments("/work/space")).toEqual([
      "--workspace",
      "/work/space",
    ]);
  });
});

function candidate(
  workspacePath: string,
  providerId: string,
  externalWorkspaceId: string,
) {
  return {
    workspacePath,
    anchorPath: workspacePath,
    providerId,
    externalWorkspaceId,
    label: workspacePath.split("/").at(-1),
    matchedSession: true,
  };
}
