import { useCallback, useEffect, useRef, useState } from "react";
import { DAEMON_EVENTS } from "@diffect/shared";
import type {
  RefList,
  RepoDiff,
  Thread,
  ThreadStatus,
  WorkspaceInfo,
} from "@diffect/shared";
import { api } from "./api.js";
import { getStoredTheme, setTheme, type Theme } from "./theme.js";
import { usePaneLayout } from "./usePaneLayout.js";
import { DiffView } from "./components/DiffView.js";
import { ThreadList } from "./components/ThreadList.js";
import { Topbar } from "./components/Topbar.js";

type StatusFilter = ThreadStatus | "all";
const STATUS_FILTERS: StatusFilter[] = ["open", "resolved", "dismissed", "all"];

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [worktree, setWorktree] = useState<string | null>(null);
  const [target, setTarget] = useState("work");
  const [diff, setDiff] = useState<RepoDiff | null>(null);
  const [refs, setRefs] = useState<RefList | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [filter, setFilter] = useState<StatusFilter>("open");
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);
  const [error, setError] = useState<string | null>(null);

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  };

  const {
    collapsed: paneCollapsed,
    toggleCollapsed,
    startResize,
    columns: paneColumns,
  } = usePaneLayout();

  // Monotonic tokens so a slow response can never overwrite a newer one — a
  // burst of SSE events or a selector change must always land last-issued-wins.
  const threadSeq = useRef(0);
  const diffSeq = useRef(0);

  const refreshThreads = useCallback(async () => {
    const seq = ++threadSeq.current;
    try {
      const next = await api.threads();
      if (seq === threadSeq.current) setThreads(next);
    } catch (e) {
      if (seq === threadSeq.current) setError(String(e));
    }
  }, []);

  const refreshDiff = useCallback(async () => {
    if (!repo) return;
    const seq = ++diffSeq.current;
    try {
      const next = await api.diff(repo, { worktree, target });
      if (seq === diffSeq.current) setDiff(next);
    } catch (e) {
      if (seq === diffSeq.current) setError(String(e));
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

  // Load the repo's refs (branches/tags/commits) for the compare picker.
  useEffect(() => {
    if (!repo) return;
    let live = true;
    api
      .refs(repo, worktree)
      .then((r) => live && setRefs(r))
      .catch(() => live && setRefs(null));
    return () => {
      live = false;
    };
  }, [repo, worktree]);

  useEffect(() => {
    refreshDiff();
  }, [refreshDiff]);

  // Live updates: subscribe to the daemon's SSE stream exactly once and route
  // events to the *latest* refreshers via a ref. Re-subscribing whenever a
  // selector changed would tear the EventSource down and drop events that fire
  // during the reconnect gap.
  const refreshers = useRef({ refreshThreads, refreshDiff });
  refreshers.current = { refreshThreads, refreshDiff };
  useEffect(() => {
    return api.subscribe((type) => {
      if (type === DAEMON_EVENTS.threadChanged) refreshers.current.refreshThreads();
      else if (type === DAEMON_EVENTS.diffChanged) refreshers.current.refreshDiff();
    });
  }, []);

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
  const editors = workspace.editors ?? [];

  return (
    <div className="app">
      <Topbar
        workspace={workspace}
        repo={repo}
        onRepo={setRepo}
        worktree={worktree}
        onWorktree={setWorktree}
        target={target}
        onTarget={setTarget}
        refs={refs}
        openCount={openCount}
        theme={theme}
        onToggleTheme={toggleTheme}
        paneCollapsed={paneCollapsed}
        onTogglePane={toggleCollapsed}
      />
      <main className="layout" style={{ gridTemplateColumns: paneColumns }}>
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
        {!paneCollapsed && (
          <div
            className="pane-resizer"
            onMouseDown={startResize}
            title="Drag to resize"
          />
        )}
        {!paneCollapsed && (
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
        )}
      </main>
    </div>
  );
}
