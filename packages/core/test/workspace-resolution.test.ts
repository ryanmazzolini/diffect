import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  DiffectSettings,
  WorkspaceBinding,
  WorkspaceProviderConfig,
} from "@diffect/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/daemon.js";
import { git } from "../src/git/exec.js";
import { replaceSettings } from "../src/store/settings.js";
import {
  parseWorkspaceResolutionRequest,
  resolveWorkspace,
} from "../src/workspace-providers/resolve.js";

let root: string;
let xdg: string;
let previousXdg: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "diffect-resolution-"));
  xdg = join(root, "xdg");
  previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
});

afterEach(async () => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  await rm(root, { recursive: true, force: true });
});

describe("workspace resolver", () => {
  it("validates and selects an explicit workspace without invoking providers", async () => {
    const repo = await mkRepo(join(root, "repo"));
    const response = await resolveWorkspace(
      { explicitWorkspace: repo },
      settings([{ id: "cwd", kind: "cwd", enabled: true }]),
    );
    const canonicalRepo = await realpath(repo);

    expect(response).toEqual({
      selected: {
        workspacePath: canonicalRepo,
        anchorPath: canonicalRepo,
        providerId: null,
        label: "repo",
        matchedSession: false,
      },
      candidates: [
        {
          workspacePath: canonicalRepo,
          anchorPath: canonicalRepo,
          providerId: null,
          label: "repo",
          matchedSession: false,
        },
      ],
      results: [],
    });
  });

  it("promotes a session repo under worktrees/<ticket> while preserving its anchor", async () => {
    const workspace = join(root, "worktrees", "ticket");
    const repo = await mkRepo(join(workspace, "diffect"));
    const nested = join(repo, "packages", "core");
    await mkdir(nested, { recursive: true });

    const response = await resolveWorkspace(
      { cwd: nested },
      settings([{ id: "cwd", kind: "cwd", enabled: true }]),
    );

    expect(response.selected).toMatchObject({
      workspacePath: await realpath(workspace),
      anchorPath: await realpath(repo),
      providerId: "cwd",
      matchedSession: false,
    });
  });

  it("uses an exact Pi session binding and retains the matching repo anchor", async () => {
    const workspace = join(root, "worktrees", "bound-ticket");
    const repo = await mkRepo(join(workspace, "diffect"));
    const sessionDir = join(root, "pi-sessions", "project");
    const sessionFile = await mkSession(sessionDir, repo, 1_000);
    const providers: WorkspaceProviderConfig[] = [
      {
        id: "pi",
        kind: "pi-session",
        enabled: true,
        sessionsPath: join(root, "pi-sessions"),
      },
    ];
    const bindings: WorkspaceBinding[] = [
      {
        providerId: "pi",
        externalWorkspaceId: sessionDir,
        diffectWorkspacePath: workspace,
      },
    ];

    const response = await resolveWorkspace(
      { agentSession: { provider: "pi", id: "session-1", path: sessionFile } },
      settings(providers, bindings),
    );

    expect(response.selected).toMatchObject({
      workspacePath: await realpath(workspace),
      anchorPath: await realpath(repo),
      providerId: "pi",
      externalWorkspaceId: sessionDir,
      matchedSession: true,
    });
    expect(response.results).toHaveLength(1);
  });

  it("preserves a repo anchor when a binding selects an ordinary container", async () => {
    const workspace = join(root, "multi-repo-workspace");
    const repo = await mkRepo(join(workspace, "diffect"));
    const sessionDir = join(root, "pi-sessions", "project");
    const sessionFile = await mkSession(sessionDir, repo, 1_000);

    const response = await resolveWorkspace(
      { agentSession: { provider: "pi", path: sessionFile } },
      settings(
        [
          {
            id: "pi",
            kind: "pi-session",
            enabled: true,
            sessionsPath: join(root, "pi-sessions"),
          },
        ],
        [
          {
            providerId: "pi",
            externalWorkspaceId: sessionDir,
            diffectWorkspacePath: workspace,
          },
        ],
      ),
    );

    expect(response.selected).toMatchObject({
      workspacePath: await realpath(workspace),
      anchorPath: await realpath(repo),
    });
  });

  it("reports a stale binding and falls back to the provider's valid context", async () => {
    const repo = await mkRepo(join(root, "repo"));
    const sessionDir = join(root, "pi-sessions", "project");
    const sessionFile = await mkSession(sessionDir, repo, 1_000);
    const providers: WorkspaceProviderConfig[] = [
      {
        id: "pi",
        kind: "pi-session",
        enabled: true,
        sessionsPath: join(root, "pi-sessions"),
      },
    ];

    const response = await resolveWorkspace(
      { agentSession: { provider: "pi", path: sessionFile } },
      settings(providers, [
        {
          providerId: "pi",
          externalWorkspaceId: sessionDir,
          diffectWorkspacePath: join(root, "missing"),
        },
      ]),
    );

    expect(response.selected?.workspacePath).toBe(await realpath(repo));
    expect(response.results[0]?.message).toContain("binding is no longer valid");
  });

  it("returns equally ranked recent Pi projects for interactive selection", async () => {
    const first = await mkRepo(join(root, "first"));
    const second = await mkRepo(join(root, "second"));
    const sessionsRoot = join(root, "pi-sessions");
    await mkSession(join(sessionsRoot, "first-project"), first, 1_000);
    await mkSession(join(sessionsRoot, "second-project"), second, 2_000);

    const response = await resolveWorkspace(
      {},
      settings([
        {
          id: "pi",
          kind: "pi-session",
          enabled: true,
          sessionsPath: sessionsRoot,
        },
        { id: "cwd", kind: "cwd", enabled: true },
      ]),
    );

    expect(response.selected).toBeNull();
    expect(response.candidates.map((candidate) => candidate.workspacePath)).toEqual([
      await realpath(second),
      await realpath(first),
    ]);
    expect(response.results.every((result) => result.providerId === "pi")).toBe(true);
  });

  it("does not let newer stale projects hide an older valid session workspace", async () => {
    const repo = await mkRepo(join(root, "older-valid"));
    const sessionsRoot = join(root, "pi-sessions");
    await mkSession(join(sessionsRoot, "valid"), repo, 1_000);
    for (let index = 0; index < 20; index++) {
      await mkSession(
        join(sessionsRoot, `stale-${index}`),
        join(root, `missing-${index}`),
        2_000 + index,
      );
    }

    const response = await resolveWorkspace(
      {},
      settings([
        {
          id: "pi",
          kind: "pi-session",
          enabled: true,
          sessionsPath: sessionsRoot,
        },
      ]),
    );

    expect(response.selected?.workspacePath).toBe(await realpath(repo));
    expect(response.results).toHaveLength(21);
  });

  it("prefers an older binding beyond the candidate display limit", async () => {
    const sessionsRoot = join(root, "pi-sessions");
    const boundRepo = await mkRepo(join(root, "bound-repo"));
    const boundProject = join(sessionsRoot, "older-bound");
    await mkSession(boundProject, boundRepo, 1_000);
    for (let index = 0; index < 20; index++) {
      const repo = await mkRepo(join(root, `newer-repo-${index}`));
      await mkSession(
        join(sessionsRoot, `newer-project-${index}`),
        repo,
        2_000 + index,
      );
    }

    const response = await resolveWorkspace(
      {},
      settings(
        [
          {
            id: "pi",
            kind: "pi-session",
            enabled: true,
            sessionsPath: sessionsRoot,
          },
        ],
        [
          {
            providerId: "pi",
            externalWorkspaceId: boundProject,
            diffectWorkspacePath: boundRepo,
          },
        ],
      ),
    );

    expect(response.selected).toMatchObject({
      workspacePath: await realpath(boundRepo),
      externalWorkspaceId: boundProject,
    });
  });

  it("retains binding provenance when session projects dedupe to one workspace", async () => {
    const repo = await mkRepo(join(root, "shared-repo"));
    const sessionsRoot = join(root, "pi-sessions");
    const newestProject = join(sessionsRoot, "newest-unbound");
    const boundProject = join(sessionsRoot, "older-bound");
    await mkSession(newestProject, repo, 2_000);
    await mkSession(boundProject, repo, 1_000);

    const response = await resolveWorkspace(
      {},
      settings(
        [
          {
            id: "pi",
            kind: "pi-session",
            enabled: true,
            sessionsPath: sessionsRoot,
          },
        ],
        [
          {
            providerId: "pi",
            externalWorkspaceId: boundProject,
            diffectWorkspacePath: repo,
          },
        ],
      ),
    );

    expect(response.selected).toMatchObject({
      workspacePath: await realpath(repo),
      externalWorkspaceId: boundProject,
    });
  });

  it("continues to cwd when a higher-priority session provider is unavailable", async () => {
    const repo = await mkRepo(join(root, "repo"));
    const response = await resolveWorkspace(
      { cwd: repo },
      settings([
        {
          id: "pi",
          kind: "pi-session",
          enabled: true,
          sessionsPath: join(root, "missing-sessions"),
        },
        { id: "cwd", kind: "cwd", enabled: true },
      ]),
    );

    expect(response.selected).toMatchObject({
      workspacePath: await realpath(repo),
      providerId: "cwd",
    });
    expect(response.results.map((result) => result.status)).toEqual([
      "unavailable",
      "available",
    ]);
  });

  it("matches a Claude session by caller context", async () => {
    const repo = await mkRepo(join(root, "claude-repo"));
    const response = await resolveWorkspace(
      { agentSession: { provider: "claude", id: "claude-1", cwd: repo } },
      settings([
        {
          id: "claude",
          kind: "claude-session",
          enabled: true,
          projectsPath: join(root, "unused"),
        },
      ]),
    );

    expect(response.selected).toMatchObject({
      workspacePath: await realpath(repo),
      providerId: "claude",
      externalWorkspaceId: "claude-1",
      matchedSession: true,
    });
  });

  it("reports form-friendly request validation paths", () => {
    expect(() =>
      parseWorkspaceResolutionRequest({
        cwd: "relative",
        agentSession: { provider: "other", path: "also-relative" },
        extra: true,
      }),
    ).toThrowError(expect.objectContaining({
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "cwd" }),
        expect.objectContaining({ path: "agentSession.provider" }),
        expect.objectContaining({ path: "agentSession.path" }),
        expect.objectContaining({ path: "extra" }),
      ]),
    }));
  });
});

describe("workspace resolution route", () => {
  it("resolves with saved settings and rejects invalid bodies", async () => {
    const repo = await mkRepo(join(root, "route-repo"));
    await replaceSettings(settings([{ id: "cwd", kind: "cwd", enabled: true }]));
    const { server, base } = await startServer("127.0.0.1");
    try {
      const response = await fetch(`${base}/workspace-resolution`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: repo }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        selected: { workspacePath: await realpath(repo), providerId: "cwd" },
      });

      const invalid = await fetch(`${base}/workspace-resolution`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: "relative" }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        issues: [{ path: "cwd", message: "must be an absolute path" }],
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("is unavailable on a network-bound daemon", async () => {
    const { server, base } = await startServer("0.0.0.0");
    try {
      const response = await fetch(`${base}/workspace-resolution`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function settings(
  providers: WorkspaceProviderConfig[],
  bindings: WorkspaceBinding[] = [],
): DiffectSettings {
  return {
    version: 1,
    workspaceResolution: { providers, bindings },
  };
}

async function mkRepo(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await git(path, ["init", "-b", "main"]);
  return path;
}

async function mkSession(
  dir: string,
  cwd: string,
  mtimeSeconds: number,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, "session.jsonl");
  await writeFile(
    file,
    `${JSON.stringify({ type: "session", version: 3, id: "session", cwd })}\n`,
    "utf8",
  );
  await utimes(file, mtimeSeconds, mtimeSeconds);
  return file;
}

async function startServer(host: string) {
  const server = await createServer({ host });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}
