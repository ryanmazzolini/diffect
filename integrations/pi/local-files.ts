import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function findLocalFile(
  relativePath: string,
  extensionModulePath: string,
): string | null {
  const extensionDirectory = dirname(realpathSync(extensionModulePath));
  for (const root of ancestors(extensionDirectory)) {
    const path = resolve(root, relativePath);
    if (existsSync(path)) return path;
  }
  return null;
}

export function resolveTrustedCommand(
  commandPath: string,
  lookupDirectory: string,
  workspaceDirectory: string,
): string | null {
  let command: string;
  try {
    command = realpathSync(resolve(lookupDirectory, commandPath));
  } catch {
    return null;
  }

  const workspace = realpathSync(workspaceDirectory);
  const relativeCommand = relative(workspace, command);
  const outsideWorkspace =
    relativeCommand === ".." || relativeCommand.startsWith(`..${sep}`) || isAbsolute(relativeCommand);
  return outsideWorkspace ? command : null;
}

function* ancestors(start: string): Generator<string> {
  let directory = resolve(start);
  while (true) {
    yield directory;
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
