import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The central review store is keyed off XDG_CONFIG_HOME. Override it per test
// file so stores land in a throwaway dir, never the developer's ~/.config, and
// stay isolated between files. Within a file, each test uses a unique repo root,
// so stores are further isolated by repo-path hash.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "diffect-xdg-"));

// Make git hermetic: the suite's git() calls otherwise read the developer's real
// ~/.gitconfig and /etc/gitconfig (init.defaultBranch, hooks, signing, includeIf,
// aliases…), which makes results machine-dependent. Neutralize global/system
// config for tests only — production exec.ts deliberately respects the user's
// config. (Tests set user.name/email per temp repo, so nothing here is needed.)
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";
