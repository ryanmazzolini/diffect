import type { PullRequestLink } from "@diffect/shared";
import { gitTry } from "./exec.js";

const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 1_500;

interface GitHubRepoRef {
  owner: string;
  repo: string;
}

const cache = new Map<string, { expiresAt: number; value: PullRequestLink | null }>();

export function parseGitHubRemote(remote: string): GitHubRepoRef | null {
  const trimmed = remote.trim().replace(/\/+$/, "");
  const scp = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (scp) return { owner: scp[1]!, repo: scp[2]! };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.hostname !== "github.com") return null;
  const [owner, repo] = url.pathname
    .replace(/^\//, "")
    .replace(/\.git$/, "")
    .split("/");
  return owner && repo ? { owner, repo } : null;
}

export async function pullRequestForBranch(
  repoRoot: string,
  branch: string | null,
): Promise<PullRequestLink | null> {
  if (!branch || typeof fetch !== "function") return null;
  const remote = await gitTry(repoRoot, ["config", "--get", "remote.origin.url"]);
  const gh = remote ? parseGitHubRemote(remote) : null;
  if (!gh) return null;

  const key = `${gh.owner}/${gh.repo}:${branch}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = await fetchPullRequest(gh, branch).catch(() => null);
  if (value) cache.set(key, { expiresAt: now + CACHE_TTL_MS, value });
  else cache.delete(key);
  return value;
}

async function fetchPullRequest(
  gh: GitHubRepoRef,
  branch: string,
): Promise<PullRequestLink | null> {
  const url = new URL(`https://api.github.com/repos/${gh.owner}/${gh.repo}/pulls`);
  url.searchParams.set("state", "open");
  url.searchParams.set("head", `${gh.owner}:${branch}`);
  url.searchParams.set("per_page", "1");

  const res = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "diffect",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;

  const data: unknown = await res.json();
  const first = Array.isArray(data) ? data[0] : null;
  if (!first || typeof first !== "object") return null;

  const pr = first as Record<string, unknown>;
  return typeof pr.number === "number" && typeof pr.html_url === "string"
    ? {
        number: pr.number,
        url: pr.html_url,
        title: typeof pr.title === "string" ? pr.title : null,
      }
    : null;
}
