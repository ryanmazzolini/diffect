import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DAEMON_EVENTS } from "@diffect/shared";
import type {
  DiffFile,
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
import { orderedDiffFiles } from "./fileTree.js";
import { usePaneLayout } from "./usePaneLayout.js";
import { useResizable } from "./useResizable.js";
import { DiffView } from "./components/DiffView.js";
import { ThreadList } from "./components/ThreadList.js";
import { Topbar } from "./components/Topbar.js";
import { Sidebar } from "./components/Sidebar.js";
import { AddWorkspaceDialog } from "./components/AddWorkspaceDialog.js";

type StatusFilter = ThreadStatus | "all";
const STATUS_FILTERS: StatusFilter[] = ["open", "closed", "all"];
// Stable empty references so memoized children don't re-render on the null paths.
const EMPTY_FILES: DiffFile[] = [];
const EMPTY_EDITORS: string[] = [];

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
  const [splitView, setSplitView] = useState(
    () => getStored("diffect-split-view") === "1",
  );
  const toggleSplitView = useCallback(
    () =>
      setSplitView((s) => {
        setStored("diffect-split-view", s ? "0" : "1");
        return !s;
      }),
    [],
  );
  // Line wrapping defaults on; "0" opts into no-wrap (horizontal scroll per file).
  const [wrapLines, setWrapLines] = useState(
    () => getStored("diffect-wrap-lines") !== "0",
  );
  const toggleWrapLines = useCallback(
    () =>
      setWrapLines((w) => {
        setStored("diffect-wrap-lines", w ? "0" : "1");
        return !w;
      }),
    [],
  );
  const [addOpen, setAddOpen] = useState(false);
  const [viewed, setViewed] = useState<Set<string>>(new Set());
  const diffPaneRef = useRef<HTMLElement>(null);
  const workbenchRef = useRef<HTMLDivElement>(null);

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

  const selectFile = useCallback((path: string) => {
    setActiveFile(path);
    document.getElementById(`file-${path}`)?.scrollIntoView({ block: "start" });
  }, []);

  // Per-file "viewed" state, scoped to repo + worktree + target (the diff's
  // identity) and persisted.
  const viewedKey = repo
    ? `diffect-viewed:${repo}:${worktree ?? ""}:${target}`
    : null;
  useEffect(() => {
    if (!viewedKey) return;
    try {
      const raw = getStored(viewedKey);
      setViewed(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch {
      setViewed(new Set());
    }
  }, [viewedKey]);

  const toggleViewed = useCallback(
    (path: string) => {
      setViewed((prev) => {
        const next = new Set(prev);
        next.has(path) ? next.delete(path) : next.add(path);
        if (viewedKey) setStored(viewedKey, JSON.stringify([...next]));
        return next;
      });
    },
    [viewedKey],
  );

  const {
    collapsed: paneCollapsed,
    toggleCollapsed,
    startResize,
    columns: paneColumns,
    width: threadWidth,
  } = usePaneLayout(workbenchRef);
  // Left sidebar width — same imperative drag, written to --sidebar-w.
  const { width: sidebarWidth, startResize: startSidebarResize } = useResizable(
    workbenchRef,
    {
      storageKey: "diffect-sidebar-width",
      cssVar: "--sidebar-w",
      defaultWidth: 220,
      min: 160,
      max: 480,
    },
  );
  // React owns the pane-width vars (initial render + reconcile after a drag
  // commits); the drag itself overrides them imperatively for smoothness.
  const paneVars = {
    "--sidebar-w": `${sidebarWidth}px`,
    "--thread-w": `${threadWidth}px`,
  } as React.CSSProperties;

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

  const sidebarFiles = useMemo(() => diff?.files ?? EMPTY_FILES, [diff]);
  // Render the diff in the same order the sidebar tree shows, so the active-file
  // highlight walks the tree top-to-bottom as you scroll instead of jumping.
  const orderedFiles = useMemo(() => orderedDiffFiles(sidebarFiles), [sidebarFiles]);

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

  // j/k move between files in the diff (GitHub-style), unless typing or in a modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "j" && e.key !== "k") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable))
        return;
      if (document.querySelector(".modal-backdrop")) return;
      const paths = orderedFiles.map((f) => f.path);
      if (paths.length === 0) return;
      e.preventDefault();
      const cur = activeFile ? paths.indexOf(activeFile) : -1;
      const idx =
        e.key === "j"
          ? Math.min(paths.length - 1, cur + 1)
          : Math.max(0, cur - 1);
      const path = paths[idx];
      if (path) selectFile(path);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [orderedFiles, activeFile, selectFile]);

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

  // Derived view state, memoized so the heavy panels (diff/sidebar/threads) only
  // re-render when their own inputs change — not on every scroll-spy active-file
  // update, resize commit, or unrelated state change.
  const scopedThreads = useMemo(
    () =>
      threads.filter(
        (t) => t.repo === repo && (worktree === null || t.worktree === worktree),
      ),
    [threads, repo, worktree],
  );
  const byStatus = useMemo(
    () =>
      filter === "all"
        ? scopedThreads
        : scopedThreads.filter((t) => t.status === filter),
    [scopedThreads, filter],
  );
  const statusCounts = useMemo<Record<StatusFilter, number>>(
    () => ({
      open: scopedThreads.filter((t) => t.status === "open").length,
      closed: scopedThreads.filter((t) => t.status === "closed").length,
      all: scopedThreads.length,
    }),
    [scopedThreads],
  );
  const editors = useMemo(() => workspace?.editors ?? EMPTY_EDITORS, [workspace]);
  const openAdd = useCallback(() => setAddOpen(true), []);

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

  return (
    <div className="app">
      {toast}
      {liveRegion}
      {addOpen && (
        <AddWorkspaceDialog onClose={() => setAddOpen(false)} onAdded={setEntries} />
      )}
      <Topbar
        workspace={workspace}
        repo={repo}
        worktree={worktree}
        target={target}
        onTarget={setTarget}
        refs={refs}
        theme={theme}
        onToggleTheme={toggleTheme}
        paneCollapsed={paneCollapsed}
        onTogglePane={toggleCollapsed}
        onToggleSidebar={toggleSidebar}
      />
      <div className="workbench" ref={workbenchRef} style={paneVars}>
        {!sidebarCollapsed && (
          <>
            <Sidebar
              entries={entries}
              repo={repo}
              worktree={worktree}
              onSelectRepo={setRepo}
              onSelectWorktree={setWorktree}
              files={sidebarFiles}
              viewed={viewed}
              activeFile={activeFile}
              onSelectFile={selectFile}
              onAddWorkspace={openAdd}
            />
            <div
              className="sidebar-resizer"
              onMouseDown={startSidebarResize}
              title="Drag to resize"
            />
          </>
        )}
        <main className="layout" style={{ gridTemplateColumns: paneColumns }}>
        <section className="diff-pane" ref={diffPaneRef}>
          <DiffView
            repo={repo}
            worktree={worktree}
            diff={diff}
            files={orderedFiles}
            threads={scopedThreads}
            editors={editors}
            viewed={viewed}
            split={splitView}
            onToggleSplit={toggleSplitView}
            wrap={wrapLines}
            onToggleWrap={toggleWrapLines}
            theme={theme}
            onToggleViewed={toggleViewed}
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
                <span className="filter-count">{statusCounts[f]}</span>
              </button>
            ))}
          </div>
          <ThreadList
            threads={byStatus}
            editors={editors}
            showRepo={false}
            onChanged={refreshThreads}
          />
        </aside>
        )}
        </main>
      </div>
    </div>
  );
}
