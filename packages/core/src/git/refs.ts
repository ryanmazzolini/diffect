import type {
  CommitSummary,
  RefList,
  RefSearchOption,
  RefSearchResults,
  RepoFileList,
} from "@diffect/shared";
import { ignoredUntrackedFiles } from "./diff.js";
import { gitTry, gitWithInput } from "./exec.js";

const lines = (s: string | null): string[] =>
  (s ?? "").split("\n").filter(Boolean);

/**
 * Keep only true remote-tracking branches: drop each remote's symbolic
 * `<remote>/HEAD` pointer (it just mirrors another branch and isn't a distinct
 * compare point). A short name always contains the remote prefix slash.
 */
const isRemoteBranch = (name: string): boolean =>
  name.includes("/") && !name.endsWith("/HEAD");

const DEFAULT_SEARCH_LIMIT = 12;
const MAX_SEARCH_LIMIT = 50;
const RECENT_COMMIT_LIMIT = 30;
const METADATA_CONCURRENCY = 8;
const COMMIT_FORMAT = "%H%x09%h%x09%cn%x09%cI%x09%s";
const DIRECT_REF_FORMAT =
  "%(refname:short)%00%(objectname)%00%(objectname:short)%00%(committername)%00%(committerdate:iso-strict)%00%(subject)";
const TAG_REF_FORMAT =
  "%(refname:short)%00%(*objectname)%00%(*objectname:short)%00%(*committername)%00%(*committerdate:iso-strict)%00%(*subject)%00%(objectname)%00%(objectname:short)%00%(committername)%00%(committerdate:iso-strict)%00%(subject)";

/**
 * List a repo's branches, tags, and recent commits for the compare picker.
 * Uses gitTry so a bare repo / missing ref class yields an empty list, never an
 * error. Commits are the last 30 on HEAD's history.
 */
export async function listRefs(repoRoot: string): Promise<RefList> {
  const [branches, tags, remotes] = await Promise.all([
    listNamedRefs(repoRoot, "branch"),
    listNamedRefs(repoRoot, "tag"),
    listNamedRefs(repoRoot, "remote"),
  ]);
  const recentCommitLines = lines(
    await gitTry(repoRoot, [
      "log",
      `-${RECENT_COMMIT_LIMIT + 1}`,
      `--format=${COMMIT_FORMAT}`,
    ]),
  );
  const commitsReachRoot = recentCommitLines.length <= RECENT_COMMIT_LIMIT;
  const commits = recentCommitLines
    .slice(0, RECENT_COMMIT_LIMIT)
    .map(parseCommitLine)
    .filter((commit): commit is CommitSummary => commit !== null);
  let repoStartSha: string | null = null;
  try {
    // `mktree` derives the empty-tree id for either SHA-1 or SHA-256 repos.
    repoStartSha = (await gitWithInput(repoRoot, ["mktree"], "")).stdout.trim() || null;
  } catch {
    // Keep ref discovery usable for malformed or unsupported repositories.
  }
  return { branches, tags, remotes, commits, commitsReachRoot, repoStartSha };
}

/**
 * Search selectable compare points server-side so the browser doesn't have to
 * render a painful all-history dropdown. Branches/tags are filtered by name;
 * commits search full reachable history by subject and by SHA prefix.
 */
export async function searchRefs(
  repoRoot: string,
  query = "",
  limit = DEFAULT_SEARCH_LIMIT,
): Promise<RefSearchResults> {
  const q = query.trim();
  const capped = clampLimit(limit);
  const [branches, remotes, tags, commits] = await Promise.all([
    searchNamedRefs(repoRoot, "branch", q, capped),
    searchNamedRefs(repoRoot, "remote", q, capped),
    searchNamedRefs(repoRoot, "tag", q, capped),
    searchCommits(repoRoot, q, capped),
  ]);
  return { query: q, branches, remotes, tags, commits };
}

const NAMED_REF_SPEC: Record<
  "branch" | "tag" | "remote",
  { namespace: string; sort: string }
> = {
  branch: { namespace: "refs/heads", sort: "--sort=-committerdate" },
  remote: { namespace: "refs/remotes", sort: "--sort=-committerdate" },
  tag: { namespace: "refs/tags", sort: "--sort=-creatordate" },
};

async function listNamedRefs(
  repoRoot: string,
  kind: "branch" | "tag" | "remote",
): Promise<RefSearchOption[]> {
  const { namespace, sort } = NAMED_REF_SPEC[kind];
  const format = kind === "tag" ? TAG_REF_FORMAT : DIRECT_REF_FORMAT;
  return lines(
    await gitTry(repoRoot, ["for-each-ref", `--format=${format}`, sort, namespace]),
  )
    .map((line) => parseNamedRefLine(kind, line))
    .filter((option): option is RefSearchOption => option !== null)
    .filter((option) => kind !== "remote" || isRemoteBranch(option.label));
}

function parseNamedRefLine(
  kind: "branch" | "tag" | "remote",
  line: string,
): RefSearchOption | null {
  const fields = line.split("\0");
  const label = fields[0];
  if (!label) return null;
  const offset = kind === "tag" && fields[1] ? 1 : kind === "tag" ? 6 : 1;
  const commit = commitSummaryFromFields(fields.slice(offset, offset + 5));
  return {
    kind,
    value: kind === "tag" ? `tags/${label}` : label,
    label,
    ...(commit ?? {}),
  };
}

function commitSummaryFromFields(fields: string[]): CommitSummary | null {
  const [sha, shortSha, committer, committedAt, subject] = fields;
  if (!sha || !shortSha || !committer || !committedAt || subject === undefined) {
    return null;
  }
  return { sha, shortSha, committer, committedAt, subject };
}

async function searchNamedRefs(
  repoRoot: string,
  kind: "branch" | "tag" | "remote",
  query: string,
  limit: number,
): Promise<RefSearchOption[]> {
  const { namespace, sort } = NAMED_REF_SPEC[kind];
  const refs = lines(
    await gitTry(repoRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      sort,
      namespace,
    ]),
  ).filter((name) => kind !== "remote" || isRemoteBranch(name));
  const needle = query.toLowerCase();
  return summarizeNamedRefs(
    repoRoot,
    kind,
    refs
      .filter((name) => needle === "" || name.toLowerCase().includes(needle))
      .slice(0, limit),
  );
}

async function summarizeNamedRefs(
  repoRoot: string,
  kind: "branch" | "tag" | "remote",
  names: string[],
): Promise<RefSearchOption[]> {
  return mapWithConcurrency(names, METADATA_CONCURRENCY, async (name) => {
    // Branches/remotes resolve as-is; tags are namespaced to avoid colliding
    // with a same-named branch when handed to git.
    const value = kind === "tag" ? `tags/${name}` : name;
    const commit = await commitSummaryForRef(repoRoot, value);
    return { kind, value, label: name, ...(commit ?? {}) };
  });
}

async function searchCommits(
  repoRoot: string,
  query: string,
  limit: number,
): Promise<RefSearchOption[]> {
  const bySha = new Map<string, RefSearchOption>();
  const add = (raw: string | null) => {
    for (const line of lines(raw)) {
      const commit = parseCommitLine(line);
      if (!commit) continue;
      bySha.set(commit.sha, {
        kind: "commit",
        value: commit.sha,
        label: commit.shortSha,
        ...commit,
      });
    }
  };

  if (query === "") {
    add(await gitTry(repoRoot, commitLogArgs(limit)));
    return [...bySha.values()].slice(0, limit);
  }

  if (/^[0-9a-f]{4,64}$/i.test(query)) {
    const sha = await gitTry(repoRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${query}^{commit}`,
    ]);
    if (sha) {
      add(
        await gitTry(repoRoot, [
          "show",
          "-s",
          `--format=${COMMIT_FORMAT}`,
          sha,
        ]),
      );
    }
  }

  add(
    await gitTry(repoRoot, [
      "log",
      "--all",
      `--max-count=${limit}`,
      "--regexp-ignore-case",
      "--fixed-strings",
      `--grep=${query}`,
      `--format=${COMMIT_FORMAT}`,
    ]),
  );
  return [...bySha.values()].slice(0, limit);
}

function commitLogArgs(limit: number): string[] {
  return ["log", "--all", `--max-count=${limit}`, `--format=${COMMIT_FORMAT}`];
}

/** Whether Git resolves `ref` as a named branch/tag/remote rather than an object id. */
export async function isNamedRef(repoRoot: string, ref: string): Promise<boolean> {
  const symbolic = await gitTry(repoRoot, [
    "rev-parse",
    "--symbolic-full-name",
    "--verify",
    "--end-of-options",
    ref,
  ]);
  return symbolic?.startsWith("refs/") === true;
}

/** Resolve one ref tip without walking history; null keeps degraded rows usable. */
export async function commitSummaryForRef(
  repoRoot: string,
  ref: string,
): Promise<CommitSummary | null> {
  const line = await gitTry(repoRoot, [
    "show",
    "-s",
    `--format=${COMMIT_FORMAT}`,
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  return line ? parseCommitLine(line) : null;
}

function parseCommitLine(line: string): CommitSummary | null {
  const [sha, shortSha, committer, committedAt, ...subjectParts] = line.split("\t");
  if (!sha || !shortSha || !committer || !committedAt) return null;
  return {
    sha,
    shortSha,
    committer,
    committedAt,
    subject: subjectParts.join("\t"),
  };
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(limit)));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
}

/**
 * Every tracked file in the working tree, for the cross-file comment picker.
 * gitTry keeps a bare repo from erroring into a 500 — it just yields no files.
 */
export async function listTrackedFiles(
  repoRoot: string,
  includeIgnored = false,
): Promise<RepoFileList> {
  const files = lines(await gitTry(repoRoot, ["ls-files"]));
  if (!includeIgnored) return { files };
  return { files, ignoredFiles: await ignoredUntrackedFiles(repoRoot) };
}
