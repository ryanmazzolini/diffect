import { execFileSync } from "node:child_process";

function git(args, options = {}) {
  const workspace = process.env.GITHUB_WORKSPACE;
  const gitArgs = workspace
    ? ["-c", `safe.directory=${workspace}`, ...args]
    : args;
  const output = execFileSync("git", gitArgs, {
    cwd: workspace || process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "ignore"] : "inherit",
  });
  return typeof output === "string" ? output.trim() : "";
}

function revision(ref) {
  try {
    return git(["rev-parse", "--verify", ref], { capture: true });
  } catch {
    return null;
  }
}

function mergeBase(left, right) {
  try {
    return git(["merge-base", left, right], { capture: true });
  } catch {
    return null;
  }
}

// Check both local diff layers. `git diff --check` alone misses staged files.
git(["diff", "--check"]);
git(["diff", "--cached", "--check"]);

const head = revision("HEAD");
const pushBase = process.env.GITHUB_DIFF_BASE
  ? revision(process.env.GITHUB_DIFF_BASE)
  : null;
const configuredBase = process.env.GITHUB_BASE_REF
  ? revision(`origin/${process.env.GITHUB_BASE_REF}`)
  : revision("origin/main");
const firstParent = revision("HEAD^1");
const configuredMergeBase = configuredBase
  ? mergeBase("HEAD", configuredBase)
  : null;
let base = pushBase ?? configuredMergeBase ?? firstParent;
if (!pushBase && process.env.GITHUB_ACTIONS && base === head) {
  base = firstParent;
}

if (head && base && head !== base) {
  const range = pushBase ? `${pushBase}..HEAD` : `${base}...HEAD`;
  git(["diff", "--check", range]);
}
