import { useCallback, useEffect, useState } from "react";
import type { RepoDiff, Thread, ThreadStatus, WorkspaceInfo } from "@diffect/shared";
import { api } from "./api.js";
import { DiffView } from "./components/DiffView.js";
import { ThreadList } from "./components/ThreadList.js";

type StatusFilter = ThreadStatus | "all";
const FILTERS: StatusFilter[] = ["open", "resolved", "dismissed", "all"];

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [diff, setDiff] = useState<RepoDiff | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [filter, setFilter] = useState<StatusFilter>("open");
  const [error, setError] = useState<string | null>(null);

  const repo = workspace?.repos[0]?.name ?? null;

  const refreshThreads = useCallback(async () => {
    try {
      setThreads(await api.threads());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    api.workspace().then(setWorkspace).catch((e) => setError(String(e)));
    refreshThreads();
  }, [refreshThreads]);

  useEffect(() => {
    if (!repo) return;
    api.diff(repo).then(setDiff).catch((e) => setError(String(e)));
  }, [repo]);

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
  const visible =
    filter === "all" ? threads : threads.filter((t) => t.status === filter);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Diffect</span>
        <span className="workspace-path" title={workspace.root}>
          {workspace.root}
        </span>
        <span className="target-chip">work</span>
        <span className="spacer" />
        <span className="inbox">{openCount} open</span>
      </header>
      <main className="layout">
        <section className="diff-pane">
          <DiffView
            repo={repo}
            diff={diff}
            threads={threads}
            onChanged={refreshThreads}
          />
        </section>
        <aside className="thread-pane">
          <div className="filter-bar">
            {FILTERS.map((f) => (
              <button
                key={f}
                className={`filter ${filter === f ? "active" : ""}`}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
          <ThreadList threads={visible} onChanged={refreshThreads} />
        </aside>
      </main>
    </div>
  );
}
