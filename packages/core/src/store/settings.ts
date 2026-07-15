import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  DIFFECT_SETTINGS_VERSION,
  type DiffectSettings,
  type SettingsValidationIssue,
  type WorkspaceBinding,
  type WorkspaceProviderConfig,
  type WorkspaceProviderKind,
} from "@diffect/shared";
import { settingsPath } from "./paths.js";

const PROVIDER_KINDS: readonly WorkspaceProviderKind[] = [
  "herdr",
  "cmux",
  "pi-session",
  "claude-session",
  "cwd",
];

let tmpCounter = 0;

export class SettingsValidationError extends Error {
  constructor(readonly issues: SettingsValidationIssue[]) {
    super("settings are invalid");
    this.name = "SettingsValidationError";
  }
}

export class SettingsReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsReadError";
  }
}

export function defaultSettings(home = homedir()): DiffectSettings {
  return {
    version: DIFFECT_SETTINGS_VERSION,
    workspaceResolution: {
      providers: [
        { id: "herdr", kind: "herdr", enabled: true, command: "herdr" },
        { id: "cmux", kind: "cmux", enabled: true, command: "cmux" },
        {
          id: "pi-session",
          kind: "pi-session",
          enabled: true,
          sessionsPath: join(home, ".pi", "agent", "sessions"),
        },
        {
          id: "claude-session",
          kind: "claude-session",
          enabled: true,
          projectsPath: join(home, ".claude", "projects"),
        },
        { id: "cwd", kind: "cwd", enabled: true },
      ],
      bindings: [],
    },
  };
}

/** Read and validate settings. A missing file uses defaults without creating it. */
export async function readSettings(): Promise<DiffectSettings> {
  let raw: string;
  try {
    raw = await readFile(settingsPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultSettings();
    throw new SettingsReadError("settings file could not be read");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SettingsReadError("settings file is not valid JSON");
  }
  return parseSettings(parsed);
}

/** Validate and atomically replace the complete settings document. */
export async function replaceSettings(value: unknown): Promise<DiffectSettings> {
  const settings = parseSettings(value);
  const file = settingsPath();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${++tmpCounter}`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(tmp, file);
  return settings;
}

export function parseSettings(value: unknown): DiffectSettings {
  const issues: SettingsValidationIssue[] = [];
  const root = objectValue(value, "$", issues);
  if (!root) throw new SettingsValidationError(issues);
  unknownKeys(root, ["version", "workspaceResolution"], "", issues);

  if (root.version !== DIFFECT_SETTINGS_VERSION) {
    issue(issues, "version", `must equal ${DIFFECT_SETTINGS_VERSION}`);
  }

  const resolution = objectValue(root.workspaceResolution, "workspaceResolution", issues);
  if (!resolution) throw new SettingsValidationError(issues);
  unknownKeys(resolution, ["providers", "bindings"], "workspaceResolution", issues);

  const providersRaw = arrayValue(
    resolution.providers,
    "workspaceResolution.providers",
    issues,
  );
  const parsedProviders = (providersRaw ?? []).flatMap((value, sourceIndex) => {
    const provider = parseProvider(
      value,
      `workspaceResolution.providers[${sourceIndex}]`,
      issues,
    );
    return provider ? [{ value: provider, sourceIndex }] : [];
  });
  validateProviderIds(parsedProviders, issues);

  const bindingsRaw = arrayValue(
    resolution.bindings,
    "workspaceResolution.bindings",
    issues,
  );
  const parsedBindings = (bindingsRaw ?? []).flatMap((value, sourceIndex) => {
    const binding = parseBinding(
      value,
      `workspaceResolution.bindings[${sourceIndex}]`,
      issues,
    );
    return binding ? [{ value: binding, sourceIndex }] : [];
  });
  validateBindings(parsedBindings, parsedProviders, issues);

  if (issues.length > 0) throw new SettingsValidationError(issues);
  return {
    version: DIFFECT_SETTINGS_VERSION,
    workspaceResolution: {
      providers: parsedProviders.map((provider) => provider.value),
      bindings: parsedBindings.map((binding) => binding.value),
    },
  };
}

function parseProvider(
  value: unknown,
  path: string,
  issues: SettingsValidationIssue[],
): WorkspaceProviderConfig | null {
  const raw = objectValue(value, path, issues);
  if (!raw) return null;

  const kind = raw.kind;
  if (typeof kind !== "string" || !isProviderKind(kind)) {
    issue(issues, `${path}.kind`, `must be one of ${PROVIDER_KINDS.join(", ")}`);
    return null;
  }

  const keysByKind: Record<WorkspaceProviderKind, string[]> = {
    herdr: ["id", "kind", "enabled", "command", "session"],
    cmux: ["id", "kind", "enabled", "command", "socketPath"],
    "pi-session": ["id", "kind", "enabled", "sessionsPath"],
    "claude-session": ["id", "kind", "enabled", "projectsPath"],
    cwd: ["id", "kind", "enabled"],
  };
  unknownKeys(raw, keysByKind[kind]!, path, issues);

  const id = nonEmptyString(raw.id, `${path}.id`, issues);
  const enabled = booleanValue(raw.enabled, `${path}.enabled`, issues);
  if (id === null || enabled === null) return null;

  if (kind === "herdr") {
    const command = nonEmptyString(raw.command, `${path}.command`, issues);
    const session = optionalNonEmptyString(raw.session, `${path}.session`, issues);
    if (command === null || session === null) return null;
    return {
      id,
      kind,
      enabled,
      command,
      ...(session === undefined ? {} : { session }),
    };
  }

  if (kind === "cmux") {
    const command = nonEmptyString(raw.command, `${path}.command`, issues);
    const socketPath = optionalAbsolutePath(raw.socketPath, `${path}.socketPath`, issues);
    if (command === null || socketPath === null) return null;
    return {
      id,
      kind,
      enabled,
      command,
      ...(socketPath === undefined ? {} : { socketPath }),
    };
  }

  if (kind === "pi-session") {
    const sessionsPath = absolutePath(raw.sessionsPath, `${path}.sessionsPath`, issues);
    return sessionsPath === null ? null : { id, kind, enabled, sessionsPath };
  }

  if (kind === "claude-session") {
    const projectsPath = absolutePath(raw.projectsPath, `${path}.projectsPath`, issues);
    return projectsPath === null ? null : { id, kind, enabled, projectsPath };
  }

  return { id, kind, enabled };
}

function parseBinding(
  value: unknown,
  path: string,
  issues: SettingsValidationIssue[],
): WorkspaceBinding | null {
  const raw = objectValue(value, path, issues);
  if (!raw) return null;
  unknownKeys(
    raw,
    ["providerId", "externalWorkspaceId", "diffectWorkspacePath"],
    path,
    issues,
  );
  const providerId = nonEmptyString(raw.providerId, `${path}.providerId`, issues);
  const externalWorkspaceId = nonEmptyString(
    raw.externalWorkspaceId,
    `${path}.externalWorkspaceId`,
    issues,
  );
  const diffectWorkspacePath = absolutePath(
    raw.diffectWorkspacePath,
    `${path}.diffectWorkspacePath`,
    issues,
  );
  return providerId === null || externalWorkspaceId === null || diffectWorkspacePath === null
    ? null
    : { providerId, externalWorkspaceId, diffectWorkspacePath };
}

interface Indexed<T> {
  value: T;
  sourceIndex: number;
}

function validateProviderIds(
  providers: Indexed<WorkspaceProviderConfig>[],
  issues: SettingsValidationIssue[],
): void {
  const firstById = new Map<string, number>();
  providers.forEach(({ value: provider, sourceIndex }) => {
    const first = firstById.get(provider.id);
    if (first === undefined) firstById.set(provider.id, sourceIndex);
    else {
      issue(
        issues,
        `workspaceResolution.providers[${sourceIndex}].id`,
        `duplicates provider at index ${first}`,
      );
    }
  });
}

function validateBindings(
  bindings: Indexed<WorkspaceBinding>[],
  providers: Indexed<WorkspaceProviderConfig>[],
  issues: SettingsValidationIssue[],
): void {
  const providerById = new Map(
    providers.map(({ value: provider }) => [provider.id, provider]),
  );
  const firstByKey = new Map<string, number>();
  bindings.forEach(({ value: binding, sourceIndex }) => {
    const provider = providerById.get(binding.providerId);
    if (!provider) {
      issue(
        issues,
        `workspaceResolution.bindings[${sourceIndex}].providerId`,
        "must reference a configured provider",
      );
    } else if (provider.kind === "cwd") {
      issue(
        issues,
        `workspaceResolution.bindings[${sourceIndex}].providerId`,
        "cwd providers cannot have external workspace bindings",
      );
    }

    const key = `${binding.providerId}\0${binding.externalWorkspaceId}`;
    const first = firstByKey.get(key);
    if (first === undefined) firstByKey.set(key, sourceIndex);
    else {
      issue(
        issues,
        `workspaceResolution.bindings[${sourceIndex}].externalWorkspaceId`,
        `duplicates binding at index ${first}`,
      );
    }
  });
}

function objectValue(
  value: unknown,
  path: string,
  issues: SettingsValidationIssue[],
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issue(issues, path, "must be an object");
    return null;
  }
  return value as Record<string, unknown>;
}

function arrayValue(
  value: unknown,
  path: string,
  issues: SettingsValidationIssue[],
): unknown[] | null {
  if (!Array.isArray(value)) {
    issue(issues, path, "must be an array");
    return null;
  }
  return value;
}

function nonEmptyString(
  value: unknown,
  path: string,
  issues: SettingsValidationIssue[],
): string | null {
  if (typeof value !== "string" || !value.trim()) {
    issue(issues, path, "must be a non-empty string");
    return null;
  }
  return value;
}

/** `null` means invalid; `undefined` means omitted. */
function optionalNonEmptyString(
  value: unknown,
  path: string,
  issues: SettingsValidationIssue[],
): string | null | undefined {
  return value === undefined ? undefined : nonEmptyString(value, path, issues);
}

function booleanValue(
  value: unknown,
  path: string,
  issues: SettingsValidationIssue[],
): boolean | null {
  if (typeof value !== "boolean") {
    issue(issues, path, "must be a boolean");
    return null;
  }
  return value;
}

function absolutePath(
  value: unknown,
  path: string,
  issues: SettingsValidationIssue[],
): string | null {
  const parsed = nonEmptyString(value, path, issues);
  if (parsed === null) return null;
  if (!isAbsolute(parsed)) {
    issue(issues, path, "must be an absolute path");
    return null;
  }
  return parsed;
}

/** `null` means invalid; `undefined` means omitted. */
function optionalAbsolutePath(
  value: unknown,
  path: string,
  issues: SettingsValidationIssue[],
): string | null | undefined {
  return value === undefined ? undefined : absolutePath(value, path, issues);
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: SettingsValidationIssue[],
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) issue(issues, path ? `${path}.${key}` : key, "is not supported");
  }
}

function isProviderKind(value: string): value is WorkspaceProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value);
}

function issue(
  issues: SettingsValidationIssue[],
  path: string,
  message: string,
): void {
  issues.push({ path, message });
}
