import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The central review store is keyed off XDG_CONFIG_HOME. Override it per test
// file so stores land in a throwaway dir, never the developer's ~/.config, and
// stay isolated between files. Within a file, each test uses a unique repo root,
// so stores are further isolated by repo-path hash.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "diffect-xdg-"));
