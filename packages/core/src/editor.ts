import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, relative, resolve } from "node:path";

const run = promisify(execFile);

/**
 * Supported local editors and how to open a file at a line. Each entry is an
 * argv builder — never a shell string — so the host path and line are passed as
 * separate arguments and cannot be interpreted as shell commands.
 */
const EDITORS: Record<
  string,
  { probe: string; args: (abs: string, line: number) => string[] }
> = {
  zed: { probe: "zed", args: (abs, line) => [`${abs}:${line}`] },
  code: { probe: "code", args: (abs, line) => ["-g", `${abs}:${line}`] },
  cursor: { probe: "cursor", args: (abs, line) => ["-g", `${abs}:${line}`] },
  idea: { probe: "idea", args: (abs, line) => ["--line", String(line), abs] },
};

export type EditorName = keyof typeof EDITORS;

/** Probe the host for installed editors via `which`. */
export async function detectEditors(): Promise<EditorName[]> {
  const names = Object.keys(EDITORS) as EditorName[];
  const results = await Promise.all(
    names.map(async (name) => {
      try {
        await run("which", [EDITORS[name]!.probe]);
        return name;
      } catch {
        return null;
      }
    }),
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

  const root = resolve(repoRoot);
  const abs = resolve(root, file);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathEscapeError(`path escapes repo: ${file}`);
  }

  const safeLine = Number.isFinite(line) ? Math.max(1, Math.floor(line)) : 1;
  await run(spec.probe, spec.args(abs, safeLine));
}
