import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Runner = (command: string, args: string[]) => Promise<unknown>;

export class UnsupportedUrlError extends Error {}

export async function openExternalUrl(
  raw: string,
  run: Runner = (command, args) => execFileAsync(command, args),
): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsupportedUrlError("url must be valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsupportedUrlError("url must be http or https");
  }

  if (process.platform === "darwin") {
    await run("open", [url.href]);
  } else if (process.platform === "win32") {
    await run("rundll32", ["url.dll,FileProtocolHandler", url.href]);
  } else {
    await run("xdg-open", [url.href]);
  }
}
