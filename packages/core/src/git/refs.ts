import type { RefList, RefSearchOption, RefSearchResults, RepoFileList } from "@diffect/shared";
import { gitTry } from "./exec.js";

const lines = (s: string | null): string[] =>
  (s ?? "").split("\n").filter(Boolean);

const DEFAULT_SEARCH_LIMIT = 12;
const MAX_SEARCH_LIMIT = 50;

/**
 * List a repo's branches, tags, and recent commits for the compare picker.
 * Uses gitTry so a bare repo / missing ref class yields an empty list, never an
 * error. Commits are the last 30 on HEAD's history.
 */
export async function listRefs(repoRoot: string): Promise<RefList> {
  const branches = lines(
    await gitTry(repoRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      "--sort=-committerdate",
      "refs/heads",
    ]),
  );
  const tags = lines(
    await gitTry(repoRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      "--sort=-creatordate",
      "refs/tags",
    ]),
  );
  const commits = lines(
    await gitTry(repoRoot, ["log", "-30", "--format=%h\t%s"]),
  ).map((l) => {
    const tab = l.indexOf("\t");
    return { sha: l.slice(0, tab), subject: l.slice(tab + 1) };
  });
  return { branches, tags, commits };
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
  const [branches, tags, commits] = await Promise.all([
    searchNamedRefs(repoRoot, "branch", q, capped),
    searchNamedRefs(repoRoot, "tag", q, capped),
    searchCommits(repoRoot, q, capped),
  ]);
  return { query: q, branches, tags, commits };
}

async function searchNamedRefs(
  repoRoot: string,
  kind: "branch" | "tag",
  query: string,
  limit: number,
): Promise<RefSearchOption[]> {
  const namespace = kind === "branch" ? "refs/heads" : "refs/tags";
  const sort = kind === "branch" ? "--sort=-committerdate" : "--sort=-creatordate";
  const refs = lines(
    await gitTry(repoRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      sort,
      namespace,
    ]),
  );
  const needle = query.toLowerCase();
  return refs
    .filter((name) => needle === "" || name.toLowerCase().includes(needle))
    .slice(0, limit)
    .map((name) => ({
      kind,
      value: kind === "tag" ? `tags/${name}` : name,
      label: name,
    }));
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
        sha: commit.sha,
        subject: commit.subject,
      });
    }
  };

  if (query === "") {
    add(await gitTry(repoRoot, commitLogArgs(limit)));
    return [...bySha.values()].slice(0, limit);
  }

  if (/^[0-9a-f]{4,40}$/i.test(query)) {
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
          "--format=%h\t%H\t%s",
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
      "--format=%h\t%H\t%s",
    ]),
  );
  return [...bySha.values()].slice(0, limit);
}

function commitLogArgs(limit: number): string[] {
  return ["log", "--all", `--max-count=${limit}`, "--format=%h\t%H\t%s"];
}

function parseCommitLine(line: string):
  | { shortSha: string; sha: string; subject: string }
  | null {
  const [shortSha, sha, ...subjectParts] = line.split("\t");
  if (!shortSha || !sha) return null;
  return { shortSha, sha, subject: subjectParts.join("\t") };
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * Every tracked file in the working tree, for the cross-file comment picker.
 * gitTry keeps a bare repo from erroring into a 500 — it just yields no files.
 */
export async function listTrackedFiles(repoRoot: string): Promise<RepoFileList> {
  return { files: lines(await gitTry(repoRoot, ["ls-files"])) };
}
