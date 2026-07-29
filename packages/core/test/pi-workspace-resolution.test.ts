import { describe, expect, it } from "vitest";
import { parseSettings } from "../src/store/settings.js";
import {
  buildPiWorkspaceResolutionRequest,
  daemonWorkspaceArguments,
  decideWorkspaceCandidate,
  parseWorkspaceResolutionResponse,
  persistWorkspaceBinding,
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

  it("requests a manual choice when changing the workspace binding", () => {
    expect(
      buildPiWorkspaceResolutionRequest(
        { cwd: "/work/repo" },
        undefined,
        { selectionMode: "choose" },
      ),
    ).toMatchObject({ selectionMode: "choose" });
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

  it("retries a stale binding replacement against the latest settings", async () => {
    const initial = settingsDocument("/work/other");
    const concurrent = settingsDocument("/work/concurrent");
    const responses = [
      jsonResponse(initial, { headers: { etag: '"revision-1"' } }),
      jsonResponse({ error: "settings changed; reload and retry" }, { status: 412 }),
      jsonResponse(concurrent, { headers: { etag: '"revision-2"' } }),
      jsonResponse({ ok: true }),
    ];
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const request = async (input: string, init?: RequestInit): Promise<Response> => {
      calls.push({ input, init });
      const response = responses.shift();
      if (!response) throw new Error("unexpected settings request");
      return response;
    };

    await persistWorkspaceBinding(
      "http://127.0.0.1:7421",
      candidate("/work/new", "pi", "project-1"),
      undefined,
      request,
    );

    expect(calls).toHaveLength(4);
    expect(new Headers(calls[1]!.init?.headers).get("if-match")).toBe('"revision-1"');
    expect(new Headers(calls[3]!.init?.headers).get("if-match")).toBe('"revision-2"');
    expect(JSON.parse(calls[3]!.init?.body as string)).toMatchObject({
      workspaceResolution: {
        bindings: [
          {
            providerId: "pi",
            externalWorkspaceId: "project-2",
            diffectWorkspacePath: "/work/concurrent",
          },
          {
            providerId: "pi",
            externalWorkspaceId: "project-1",
            diffectWorkspacePath: "/work/new",
          },
        ],
      },
    });
  });

  it("starts an unseeded daemon before resolution", () => {
    expect(daemonWorkspaceArguments()).toEqual(["--no-workspace"]);
    expect(daemonWorkspaceArguments("/work/space")).toEqual([
      "--workspace",
      "/work/space",
    ]);
  });
});

function settingsDocument(projectTwoPath: string) {
  return {
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
          externalWorkspaceId: "project-2",
          diffectWorkspacePath: projectTwoPath,
        },
      ],
    },
  };
}

function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

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
