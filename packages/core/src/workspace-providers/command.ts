import { execFile, type ExecFileException } from "node:child_process";

export const PROVIDER_COMMAND_TIMEOUT_MS = 1_500;
export const PROVIDER_COMMAND_MAX_OUTPUT_BYTES = 256 * 1024;

export type ProviderCommandErrorKind =
  | "unavailable"
  | "timeout"
  | "output-limit"
  | "cancelled"
  | "failed";

export class ProviderCommandError extends Error {
  constructor(
    readonly kind: ProviderCommandErrorKind,
    message: string,
    readonly stderr = "",
  ) {
    super(message);
    this.name = "ProviderCommandError";
  }
}

export interface ProviderCommandOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface ProviderCommandOutput {
  stdout: string;
  stderr: string;
}

export type ProviderCommandRunner = (
  command: string,
  args: readonly string[],
  options?: ProviderCommandOptions,
) => Promise<ProviderCommandOutput>;

/** Run a bounded native provider command as argv, never through a shell. */
export const runProviderCommand: ProviderCommandRunner = (
  command,
  args,
  options = {},
) =>
  new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? PROVIDER_COMMAND_TIMEOUT_MS;
    const maxBuffer = options.maxOutputBytes ?? PROVIDER_COMMAND_MAX_OUTPUT_BYTES;
    const callback = (
      error: ExecFileException | null,
      stdout: string,
      stderr: string,
    ) => {
      if (!error) {
        resolve({ stdout, stderr });
        return;
      }
      const code = error.code;
      if (code === "ENOENT") {
        reject(new ProviderCommandError("unavailable", `${command} was not found`));
      } else if (code === "ABORT_ERR" || error.name === "AbortError") {
        reject(new ProviderCommandError("cancelled", `${command} was cancelled`, stderr));
      } else if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        reject(
          new ProviderCommandError(
            "output-limit",
            `${command} exceeded the output limit`,
            stderr,
          ),
        );
      } else if (error.killed) {
        reject(
          new ProviderCommandError(
            "timeout",
            `${command} timed out after ${timeoutMs}ms`,
            stderr,
          ),
        );
      } else {
        const detail = stderr.trim();
        reject(
          new ProviderCommandError(
            "failed",
            detail ? `${command} failed: ${detail}` : `${command} failed`,
            stderr,
          ),
        );
      }
    };

    try {
      execFile(
        command,
        [...args],
        {
          encoding: "utf8",
          env: options.env,
          killSignal: "SIGKILL",
          maxBuffer,
          signal: options.signal,
          timeout: timeoutMs,
          windowsHide: true,
        },
        callback,
      );
    } catch (error) {
      reject(
        error instanceof Error
          ? new ProviderCommandError("failed", error.message)
          : new ProviderCommandError("failed", `${command} failed`),
      );
    }
  });

/** Remove native-provider context variables so settings, not parent env, select state. */
export function providerCommandEnvironment(prefix: string): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith(prefix)),
  );
}
