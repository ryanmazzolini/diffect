import type { RefList } from "@diffect/shared";
import { gitTry } from "./exec.js";

const lines = (s: string | null): string[] =>
  (s ?? "").split("\n").filter(Boolean);

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
