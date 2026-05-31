import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a git command in `cwd`. Uses execFile (no shell) so paths and refs are
 * passed as argv and never interpolated into a shell string.
 */
export async function git(cwd: string, args: string[]): Promise<GitResult> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    // Keep git's output stable and locale-independent for parsing.
    env: { ...process.env, GIT_PAGER: "cat", LC_ALL: "C" },
  });
  return { stdout, stderr };
}

/** Run git and return trimmed stdout, or null if the command fails. */
export async function gitTry(
  cwd: string,
  args: string[],
): Promise<string | null> {
  try {
    const { stdout } = await git(cwd, args);
    return stdout.trim();
  } catch {
    return null;
  }
}
