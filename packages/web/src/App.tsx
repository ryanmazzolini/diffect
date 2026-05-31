import { useCallback, useEffect, useState } from "react";
import type { RepoDiff, Thread, ThreadStatus, WorkspaceInfo } from "@diffect/shared";
import { api } from "./api.js";
import { DiffView } from "./components/DiffView.js";
import { ThreadList } from "./components/ThreadList.js";

type StatusFilter = ThreadStatus | "all";
const STATUS_FILTERS: StatusFilter[] = ["open", "resolved", "dismissed", "all"];
const TARGETS = ["work", "staged", "unstaged"];

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [worktree, setWorktree] = useState<string | null>(null);
  const [target, setTarget] = useState("work");
  const [diff, setDiff] = useState<RepoDiff | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [filter, setFilter] = useState<StatusFilter>("open");
  const [error, setError] = useState<string | null>(null);

  const currentRepo = workspace?.repos.find((r) => r.name === repo) ?? null;

  const refreshThreads = useCallback(async () => {
    try {
      setThreads(await api.threads());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refreshDiff = useCallback(async () => {
    if (!repo) return;
    try {
      setDiff(await api.diff(repo, { worktree, target }));
    } catch (e) {
      setError(String(e));
    }
  }, [repo, worktree, target]);

  useEffect(() => {
    api
      .workspace()
      .then((ws) => {
        setWorkspace(ws);
        setRepo((prev) => prev ?? ws.repos[0]?.name ?? null);
      })
      .catch((e) => setError(String(e)));
    refreshThreads();
  }, [refreshThreads]);

  // Reset the worktree selection when switching repos.
  useEffect(() => {
    setWorktree(null);
  }, [repo]);

  useEffect(() => {
    refreshDiff();
  }, [refreshDiff]);

  // Live updates: re-fetch the affected panel when the daemon reports a change.
  useEffect(() => {
    return api.subscribe((type) => {
      if (type === "thread.changed") refreshThreads();
      else if (type === "diff.changed") refreshDiff();
    });
  }, [refreshThreads, refreshDiff]);

  if (error) {
    return (
      <div className="app">
        <div className="error">Failed to load: {error}</div>
      </div>
    );
  }
  if (!workspace || !repo) {
    return (
      <div className="app">
        <div className="loading">Loading workspace…</div>
      </div>
    );
  }

  const openCount = threads.filter((t) => t.status === "open").length;
  const byStatus =
    filter === "all" ? threads : threads.filter((t) => t.status === filter);
  // Inline diff threads are scoped to the repo/worktree being viewed; the inbox
  // stays cross-repo so unresolved feedback elsewhere remains visible.
  const inlineThreads = threads.filter(
    (t) => t.repo === repo && (worktree === null || t.worktree === worktree),
  );
  const multiRepo = workspace.repos.length > 1;
  const worktrees = currentRepo?.worktrees ?? [];
  const multiWorktree = worktrees.length > 1;
  const editors = workspace.editors ?? [];

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Diffect</span>
        <span className="workspace-path" title={workspace.root}>
          {workspace.root}
        </span>

        {multiRepo && (
          <select
            className="selector"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            title="Repository"
          >
            {workspace.repos.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
        )}

        {multiWorktree && (
          <select
            className="selector"
            value={worktree ?? ""}
            onChange={(e) => setWorktree(e.target.value || null)}
            title="Worktree (A/B)"
          >
            <option value="">all worktrees</option>
            {worktrees.map((w) => (
              <option key={w.name} value={w.name}>
                {w.name}
              </option>
            ))}
          </select>
        )}

        <select
          className="selector target-select"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          title="Review target"
        >
          {TARGETS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <span className="spacer" />
        <span className="inbox">{openCount} open</span>
      </header>
      <main className="layout">
        <section className="diff-pane">
          <DiffView
            repo={repo}
            worktree={worktree}
            diff={diff}
            threads={inlineThreads}
            editors={editors}
            onChanged={refreshThreads}
          />
        </section>
        <aside className="thread-pane">
          <div className="filter-bar">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f}
                className={`filter ${filter === f ? "active" : ""}`}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
          <ThreadList
            threads={byStatus}
            editors={editors}
            showRepo={multiRepo}
            onChanged={refreshThreads}
          />
        </aside>
      </main>
    </div>
  );
}
