import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { containedPath } from "./path-safe.js";

const run = promisify(execFile);

/**
 * Supported local editors and how to open a file at a line. Each entry is an
 * argv builder — never a shell string — so the host path and line are passed as
 * separate arguments and cannot be interpreted as shell commands.
 */
const jetbrainsArgs = (abs: string, line: number) => ["--line", String(line), abs];
type EditorSpec = {
  commands: string[];
  appNames?: string[];
  fileArgs: (abs: string, line: number) => string[];
  workspaceArgs?: (abs: string) => string[];
};
const EDITORS: Record<string, EditorSpec> = {
  zed: {
    commands: ["zed", "zeditor"],
    appNames: ["Zed"],
    fileArgs: (abs, line) => [`${abs}:${line}`],
  },
  code: {
    commands: ["code"],
    appNames: ["Visual Studio Code"],
    fileArgs: (abs, line) => ["-g", `${abs}:${line}`],
  },
  cursor: {
    commands: ["cursor"],
    appNames: ["Cursor"],
    fileArgs: (abs, line) => ["-g", `${abs}:${line}`],
  },
  idea: { commands: ["idea"], appNames: ["IntelliJ IDEA"], fileArgs: jetbrainsArgs },
  webstorm: { commands: ["webstorm"], appNames: ["WebStorm"], fileArgs: jetbrainsArgs },
  pycharm: { commands: ["pycharm"], appNames: ["PyCharm"], fileArgs: jetbrainsArgs },
  goland: { commands: ["goland"], appNames: ["GoLand"], fileArgs: jetbrainsArgs },
  clion: { commands: ["clion"], appNames: ["CLion"], fileArgs: jetbrainsArgs },
  phpstorm: { commands: ["phpstorm"], appNames: ["PhpStorm"], fileArgs: jetbrainsArgs },
  rubymine: { commands: ["rubymine"], appNames: ["RubyMine"], fileArgs: jetbrainsArgs },
  rider: { commands: ["rider"], appNames: ["Rider"], fileArgs: jetbrainsArgs },
  datagrip: { commands: ["datagrip"], appNames: ["DataGrip"], fileArgs: jetbrainsArgs },
};

type Launch =
  | { kind: "command"; command: string }
  | { kind: "mac-app"; appName: string };

export type EditorName = keyof typeof EDITORS;

async function commandExists(command: string): Promise<boolean> {
  try {
    await run("which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function macAppExists(appName: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const candidates = [
    join("/Applications", `${appName}.app`),
    join(homedir(), "Applications", `${appName}.app`),
  ];
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return true;
    } catch {
      /* try next path */
    }
  }
  return false;
}

async function resolveLaunch(spec: EditorSpec): Promise<Launch | null> {
  for (const command of spec.commands) {
    if (await commandExists(command)) return { kind: "command", command };
  }
  for (const appName of spec.appNames ?? []) {
    if (await macAppExists(appName)) return { kind: "mac-app", appName };
  }
  return null;
}

/** Probe the host for installed editors via CLI aliases and macOS app bundles. */
export async function detectEditors(): Promise<EditorName[]> {
  const names = Object.keys(EDITORS) as EditorName[];
  const results = await Promise.all(
    names.map(async (name) => ((await resolveLaunch(EDITORS[name]!)) ? name : null)),
  );
  return results.filter((n): n is EditorName => n !== null);
}

export class UnknownEditorError extends Error {}
export class PathEscapeError extends Error {}

/**
 * Open `repoRoot/file` at `line` in the named editor on the host. The path is
 * resolved under the repo root and confirmed to stay inside it (so a malicious
 * `../../etc/x` from a client cannot open arbitrary host files), then passed as
 * argv — no shell, no interpolation.
 */
export async function openInEditor(
  repoRoot: string,
  file: string,
  line: number,
  editor: string,
): Promise<void> {
  const spec = EDITORS[editor as EditorName];
  if (!spec) throw new UnknownEditorError(`unsupported editor: ${editor}`);

  // Confine the target to the repo (follows symlinks); never open arbitrary
  // host files even if a symlink or `..` tries to smuggle the path out.
  const abs = containedPath(repoRoot, file);
  if (!abs) throw new PathEscapeError(`path escapes repo: ${file}`);

  const launch = await resolveLaunch(spec);
  if (!launch) throw new UnknownEditorError(`editor not found: ${editor}`);
  const safeLine = Number.isFinite(line) ? Math.max(1, Math.floor(line)) : 1;
  if (launch.kind === "command") {
    await run(launch.command, spec.fileArgs(abs, safeLine));
  } else {
    // macOS app fallback opens the file but may not jump to the exact line.
    await run("open", ["-a", launch.appName, abs]);
  }
}

/** Open a trusted workspace/repo root in the named editor. */
export async function openWorkspaceInEditor(
  workspaceRoot: string,
  editor: string,
): Promise<void> {
  const spec = EDITORS[editor as EditorName];
  if (!spec) throw new UnknownEditorError(`unsupported editor: ${editor}`);
  const launch = await resolveLaunch(spec);
  if (!launch) throw new UnknownEditorError(`editor not found: ${editor}`);
  if (launch.kind === "command") {
    await run(launch.command, spec.workspaceArgs?.(workspaceRoot) ?? [workspaceRoot]);
  } else {
    await run("open", ["-a", launch.appName, workspaceRoot]);
  }
}
