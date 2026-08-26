import { chmod, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

let temporaryFile = 0;

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function writePrivateJson(
  path: string,
  value: unknown,
): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporary = `${path}.tmp-${process.pid}-${++temporaryFile}`;

  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function syncDirectory(path: string): Promise<void> {
  let directory: FileHandle | undefined;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    await directory?.close().catch(() => {});
  }
}
