import { useCallback, useEffect, useRef, useState } from "react";
import { DAEMON_EVENTS } from "@diffect/shared";
import type {
  RefList,
  RepoDiff,
  Thread,
  ThreadStatus,
  WorkspaceEntry,
  WorkspaceInfo,
} from "@diffect/shared";
import { api } from "./api.js";
import { Icon } from "./icons.js";
import { getStoredTheme, setTheme, type Theme } from "./theme.js";
import { getStored, setStored } from "./storage.js";
import { usePaneLayout } from "./usePaneLayout.js";
import { DiffView } from "./components/DiffView.js";
import { ThreadList } from "./components/ThreadList.js";
import { Topbar } from "./components/Topbar.js";
import { Sidebar } from "./components/Sidebar.js";
import { AddWorkspaceDialog } from "./components/AddWorkspaceDialog.js";

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
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => getStored("diffect-sidebar-collapsed") === "1",
  );
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const diffPaneRef = useRef<HTMLElement>(null);

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  };

  const toggleSidebar = () =>
    setSidebarCollapsed((c) => {
      setStored("diffect-sidebar-collapsed", c ? "0" : "1");
      return !c;
    });

  const loadWorkspaces = useCallback(() => {
    api.workspaces().then(setEntries).catch(() => setEntries([]));
  }, []);

  const selectFile = (path: string) => {
    setActiveFile(path);
    document.getElementById(`file-${path}`)?.scrollIntoView({ block: "start" });
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
      if (seq === threadSeq.current) {
        setThreads(next);
        setError(null); // a later success heals a stale error toast
      }
    } catch (e) {
      if (seq === threadSeq.current) setError(String(e));
    }
  }, []);

  const refreshDiff = useCallback(async () => {
    if (!repo) return;
    const seq = ++diffSeq.current;
    try {
      const next = await api.diff(repo, { worktree, target });
      if (seq === diffSeq.current) {
        setDiff(next);
        setError(null);
      }
    } catch (e) {
      if (seq === diffSeq.current) setError(String(e));
    }
  }, [repo, worktree, target]);

  const refreshWorkspace = useCallback(() => {
    api
      .workspace()
      .then((ws) => {
        setWorkspace(ws);
        setError(null);
        // Keep the current repo only if it still exists (a removed workspace must
        // not strand a dangling selection that 404s the diff); else pick the first.
        setRepo((prev) =>
          prev && ws.repos.some((r) => r.name === prev)
            ? prev
            : (ws.repos[0]?.name ?? null),
        );
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    refreshWorkspace();
    loadWorkspaces();
    refreshThreads();
  }, [refreshWorkspace, loadWorkspaces, refreshThreads]);

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

  // Scroll-spy: highlight the file in the sidebar that's at the top of the diff
  // pane as the user scrolls, so the tree tracks reading position.
  useEffect(() => {
    const root = diffPaneRef.current;
    if (!root || !diff) return;
    const headers = diff.files
      .map((f) => document.getElementById(`file-${f.path}`))
      .filter((el): el is HTMLElement => el !== null);
    if (headers.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActiveFile(top.target.id.replace(/^file-/, ""));
      },
      { root, rootMargin: "0px 0px -70% 0px", threshold: 0 },
    );
    headers.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [diff]);

  // Live updates: subscribe to the daemon's SSE stream exactly once and route
  // events to the *latest* refreshers via a ref. Re-subscribing whenever a
  // selector changed would tear the EventSource down and drop events that fire
  // during the reconnect gap.
  const refreshers = useRef({ refreshThreads, refreshDiff, refreshWorkspace, loadWorkspaces });
  refreshers.current = { refreshThreads, refreshDiff, refreshWorkspace, loadWorkspaces };
  useEffect(() => {
    return api.subscribe((type) => {
      const r = refreshers.current;
      if (type === DAEMON_EVENTS.threadChanged) {
        r.refreshThreads();
        setLive("Review threads updated");
      } else if (type === DAEMON_EVENTS.diffChanged) {
        r.refreshDiff();
        setLive("Diff updated");
      } else if (type === DAEMON_EVENTS.workspaceChanged) {
        r.refreshWorkspace();
        r.loadWorkspaces();
        setLive("Workspaces updated");
      }
    });
  }, []);

  // A failed fetch no longer replaces the whole app; it shows a dismissible
  // banner so the current view stays usable and recoverable.
  const toast = error ? (
    <div className="toast error-toast" role="alert">
      <Icon name="alert" size={14} />
      <span className="toast-msg">{error}</span>
      <button
        type="button"
        className="icon-btn"
        aria-label="Dismiss error"
        onClick={() => setError(null)}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  ) : null;
  // Polite live region so screen readers hear SSE-driven changes.
  const liveRegion = (
    <div aria-live="polite" className="sr-only">
      {live}
    </div>
  );

  if (!workspace || !repo) {
    return (
      <div className="app">
        {toast}
        {liveRegion}
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
      {toast}
      {liveRegion}
      {addOpen && (
        <AddWorkspaceDialog onClose={() => setAddOpen(false)} onAdded={setEntries} />
      )}
      <Topbar
        workspace={workspace}
        target={target}
        onTarget={setTarget}
        refs={refs}
        openCount={openCount}
        theme={theme}
        onToggleTheme={toggleTheme}
        paneCollapsed={paneCollapsed}
        onTogglePane={toggleCollapsed}
        onToggleSidebar={toggleSidebar}
      />
      <div className="workbench">
        {!sidebarCollapsed && (
          <Sidebar
            entries={entries}
            repo={repo}
            worktree={worktree}
            onSelectRepo={setRepo}
            onSelectWorktree={setWorktree}
            files={diff?.files ?? []}
            activeFile={activeFile}
            onSelectFile={selectFile}
            onAddWorkspace={() => setAddOpen(true)}
          />
        )}
        <main className="layout" style={{ gridTemplateColumns: paneColumns }}>
        <section className="diff-pane" ref={diffPaneRef}>
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
    </div>
  );
}
