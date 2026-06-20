import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DAEMON_EVENTS } from "@diffect/shared";
import type {
  ArchivedSession,
  DiffFile,
  RefList,
  RepoDiff,
  RepoSummary,
  ReviewSession,
  ReviewTargetKind,
  Thread,
  ThreadStatus,
  WorkspaceEntry,
  WorkspaceInfo,
} from "@diffect/shared";
import { api } from "./api.js";
import { Icon } from "./icons.js";
import { getStoredTheme, setTheme, type Theme } from "./theme.js";
import { getStoredDensity, setDensity, type Density } from "./density.js";
import { getStored, setStored } from "./storage.js";
import { orderedDiffFiles } from "./fileTree.js";
import { CurrentSnapshotContext } from "./currentSnapshot.js";
import { usePaneLayout } from "./usePaneLayout.js";
import { useResizable } from "./useResizable.js";
import { DiffView } from "./components/DiffView.js";
import { ThreadList } from "./components/ThreadList.js";
import { Topbar } from "./components/Topbar.js";
import { Sidebar, type SnapshotGroup } from "./components/Sidebar.js";
import { AddWorkspaceDialog } from "./components/AddWorkspaceDialog.js";

type StatusFilter = ThreadStatus | "all";
const STATUS_FILTERS: StatusFilter[] = ["open", "closed", "all"];
// Stable empty references so memoized children don't re-render on the null paths.
const EMPTY_FILES: DiffFile[] = [];
const EMPTY_EDITORS: string[] = [];
const EMPTY_SESSIONS: ReviewSession[] = [];
const EMPTY_ARCHIVED: ArchivedSession[] = [];
// Per-session dismissal of the "looks complete" suggestion. This is a UI
// preference (correctly browser-local), unlike the archive *fact* itself, which
// is a durable shared event in the per-repo log.
const COMPLETE_DISMISS_KEY = "diffect-complete-dismissed";
function loadDismissedComplete(): Set<string> {
  try {
    const raw = getStored(COMPLETE_DISMISS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
// The session-count map key standing in for legacy (pre-scope, sessionId === null)
// threads, which share the dedicated unscoped bucket rather than any one session.
const LEGACY_KEY = "__legacy__";
// Kinds whose session identity is worktree/branch-independent, so a scope stored
// on a thread round-trips to the same diff-route id no matter what's checked out
// now. `work`/`ref` resolve `headRef` from the LIVE branch (reviews/scope.ts), so
// a session reconstructed for a branch no longer checked out would re-stamp a
// *different* id on selection — orphaning itself. We therefore only reconstruct
// these stable kinds from thread scopes; live `work` sessions come from the server
// (one per checked-out worktree), and the active diff is always selectable on its own.
const STABLE_KINDS: ReadonlySet<ReviewTargetKind> = new Set([
  "range",
  "staged",
  "unstaged",
]);

const DEFAULT_TARGET = "work";
interface DeepLinkSelection {
  repo: string | null;
  worktree: string | null;
  target: string;
}
function cleanQueryValue(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
function readInitialDeepLink(): DeepLinkSelection {
  if (typeof window === "undefined") {
    return { repo: null, worktree: null, target: DEFAULT_TARGET };
  }
  const q = new URLSearchParams(window.location.search);
  return {
    repo: cleanQueryValue(q.get("repo")),
    worktree: cleanQueryValue(q.get("worktree")),
    target: cleanQueryValue(q.get("target")) ?? DEFAULT_TARGET,
  };
}

export function App() {
  const [initialDeepLink] = useState(readInitialDeepLink);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [repo, setRepo] = useState<string | null>(initialDeepLink.repo);
  const [worktree, setWorktree] = useState<string | null>(initialDeepLink.worktree);
  const [target, setTarget] = useState(initialDeepLink.target);
  // The unscoped/legacy bucket is open: the thread pane shows pre-scope threads
  // (sessionId === null) instead of the active session's. A flag, not a magic
  // target, so it never collides with a real review scope.
  const [showUnscoped, setShowUnscoped] = useState(false);
  // Optimistic session highlight: the id we *expect* the diff route to stamp for
  // the entry the user just clicked, shown until the real diff settles. Fix 1
  // guarantees every selectable entry round-trips, so it never lingers on a
  // mismatch; `refreshDiff` retires it on settle — success OR error — so an
  // errored diff route can't strand the highlight on a session that won't load.
  const [pendingSession, setPendingSession] = useState<string | null>(null);
  // Bumped on every sidebar selection to force a diff reload even when the
  // resulting (worktree, target) equals the current one. Without it, re-selecting
  // the active session is a state no-op: no fetch fires, so the optimistic
  // `pendingSession` set below never gets a settle to retire it — and a session
  // whose diff previously errored could never be retried by re-clicking its row.
  const [reselectTick, setReselectTick] = useState(0);
  const [diff, setDiff] = useState<RepoDiff | null>(null);
  const [refs, setRefs] = useState<RefList | null>(null);
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [filter, setFilter] = useState<StatusFilter>("open");
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);
  const [density, setDensityState] = useState<Density>(getStoredDensity);
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
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
  // Optimistic archive/revive overrides keyed by session id, applied over the
  // server's archivedSessions until the SSE refetch catches up. Lets the
  // banner/sidebar react instantly, and rolls back on a failed POST. The session
  // is carried so an optimistically-archived id can render in the Archived group
  // (with its scope) before the durable event round-trips. The origin `repo` is
  // carried too: session ids aren't repo-qualified, so an override is only ever
  // applied/reconciled while that repo is active — switching repos mid-flight
  // must not leak the pin into another repo's Archived group.
  const [archiveOverrides, setArchiveOverrides] = useState<
    Map<string, { archived: boolean; session: ReviewSession; repo: string }>
  >(() => new Map());
  const [dismissedComplete, setDismissedComplete] = useState<Set<string>>(
    loadDismissedComplete,
  );
  const diffPaneRef = useRef<HTMLElement>(null);
  const workbenchRef = useRef<HTMLDivElement>(null);

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  };

  const changeDensity = useCallback((next: Density) => {
    setDensity(next);
    setDensityState(next);
  }, []);

  const toggleSidebar = () =>
    setSidebarCollapsed((c) => {
      setStored("diffect-sidebar-collapsed", c ? "0" : "1");
      return !c;
    });

  const loadWorkspaces = useCallback(() => {
    api.workspaces().then(setEntries).catch(() => setEntries([]));
  }, []);

  const selectFile = useCallback(
    (path: string) => {
      const inDiff = diff?.files.some((f) => f.path === path || f.oldPath === path) ?? false;
      setActiveFile(path);
      if (inDiff) {
        setPreviewFile(null);
        document.getElementById(`file-${path}`)?.scrollIntoView({ block: "start" });
      } else {
        setPreviewFile(path);
        diffPaneRef.current?.scrollTo({ top: 0 });
      }
    },
    [diff],
  );

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
        // Selection settled — retire the optimistic highlight (now == diff.sessionId).
        setPendingSession(null);
      }
    } catch (e) {
      if (seq === diffSeq.current) {
        setError(String(e));
        // The selection settled with an error (e.g. a reconstructed range whose
        // base ref was deleted → 500, or a removed worktree → 404). Retire the
        // optimistic highlight too, or it would pin the sidebar + thread filter to
        // a session whose diff never loads, with no self-recovery on re-click.
        setPendingSession(null);
      }
    }
  }, [repo, worktree, target, reselectTick]);

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

  // Switching repos lands on its primary `work` session with the unscoped bucket
  // closed — a range/staged target is repo-specific and meaningless elsewhere.
  const firstRepoEffect = useRef(true);
  useEffect(() => {
    if (firstRepoEffect.current) {
      firstRepoEffect.current = false;
      return;
    }
    setWorktree(null);
    setTarget(DEFAULT_TARGET);
    setShowUnscoped(false);
    setPendingSession(null);
  }, [repo]);

  // Picking a target in the Topbar navigates to a real diff/session, so it must
  // also leave the unscoped bucket (which overrides the thread filter). We can't
  // predict the resulting session id from the target alone, so drop any optimistic
  // highlight and let the landing diff settle it.
  const changeTarget = useCallback((next: string) => {
    setShowUnscoped(false);
    setPendingSession(null);
    setTarget(next);
  }, []);

  // Selecting a sidebar review entry sets its checkout + target together so the
  // diff route re-resolves to that session; we optimistically highlight its id so
  // the sidebar + thread filter switch instantly instead of flashing the previous
  // session until the async diff lands. Legacy selection only flips the bucket
  // flag — unscoped threads have no single diff to show.
  const selectSession = useCallback((s: ReviewSession) => {
    setShowUnscoped(false);
    setPendingSession(s.id);
    setWorktree(s.worktree);
    setTarget(s.scope.target);
    // Force a reload even if (worktree, target) are unchanged, so the optimistic
    // highlight always has a settle to retire it and a failed session can retry.
    setReselectTick((n) => n + 1);
  }, []);
  const selectLegacy = useCallback(() => {
    setPendingSession(null);
    setShowUnscoped(true);
  }, []);

  // Archive (`archived: true`) or revive (`archived: false`) a session. Optimistic:
  // record the override so the banner/sidebar flip immediately, POST the scope (the
  // server re-derives the id), and roll the override back if the write fails. The
  // SSE `workspace.changed` broadcast refetches the durable set, which the
  // reconciler below then folds in, retiring the override.
  const setArchived = useCallback(
    async (session: ReviewSession, archived: boolean) => {
      if (!repo) return;
      setArchiveOverrides((prev) =>
        new Map(prev).set(session.id, { archived, session, repo }),
      );
      try {
        await api.archiveSession(repo, { scope: session.scope, archived });
      } catch (e) {
        setError(String(e));
        setArchiveOverrides((prev) => {
          const next = new Map(prev);
          next.delete(session.id);
          return next;
        });
      }
    },
    [repo],
  );
  const reviveSession = useCallback(
    (session: ReviewSession) => {
      void setArchived(session, false);
    },
    [setArchived],
  );
  const dismissComplete = useCallback((id: string) => {
    setDismissedComplete((prev) => {
      const next = new Set(prev).add(id);
      setStored(COMPLETE_DISMISS_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  useEffect(() => {
    setPreviewFile(null);
  }, [repo, worktree, target]);

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

  // Load every tracked file for the sidebar's All files mode.
  useEffect(() => {
    if (!repo) return;
    let live = true;
    api
      .repoFiles(repo, worktree)
      .then((r) => live && setAllFiles(r.files))
      .catch(() => live && setAllFiles([]));
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
    if (!root || !diff || previewFile) return;
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
  }, [diff, previewFile]);

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
  // A branch checkout writes the working tree (→ diff.changed) without a
  // workspace.changed, so the sidebar's session labels go stale unless we
  // re-derive them. But re-deriving re-shells git over *every* repo + worktree,
  // and diff.changed is debounced only 120ms server-side with no client debounce —
  // a burst of edits would spawn a git storm. So coalesce the workspace refresh
  // to a trailing debounce; the diff itself still refreshes immediately below.
  const workspaceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshWorkspaceSoon = useCallback(() => {
    if (workspaceTimer.current) clearTimeout(workspaceTimer.current);
    workspaceTimer.current = setTimeout(() => {
      workspaceTimer.current = null;
      refreshers.current.refreshWorkspace();
      refreshers.current.loadWorkspaces();
    }, 750);
  }, []);
  useEffect(() => () => {
    if (workspaceTimer.current) clearTimeout(workspaceTimer.current);
  }, []);
  useEffect(() => {
    return api.subscribe((type) => {
      const r = refreshers.current;
      if (type === DAEMON_EVENTS.threadChanged) {
        r.refreshThreads();
        setLive("Review threads updated");
      } else if (type === DAEMON_EVENTS.diffChanged) {
        r.refreshDiff();
        refreshWorkspaceSoon();
        setLive("Diff updated");
      } else if (type === DAEMON_EVENTS.workspaceChanged) {
        // An explicit workspace change is rarer and structural — refresh now.
        r.refreshWorkspace();
        r.loadWorkspaces();
        setLive("Workspaces updated");
      }
    });
  }, [refreshWorkspaceSoon]);

  // Derived view state, memoized so the heavy panels (diff/sidebar/threads) only
  // re-render when their own inputs change — not on every scroll-spy active-file
  // update, resize commit, or unrelated state change.
  // The session resolved for the current (repo, worktree, target); threads bind
  // to it so comments follow the changeset, not the worktree directory. While a
  // selection is in flight we honor the optimistic `pendingSession` so the
  // highlight + thread filter switch instantly (Fix 1 guarantees it round-trips);
  // the unscoped bucket overrides everything, so its threads aren't a session.
  const currentSession =
    !showUnscoped && pendingSession ? pendingSession : (diff?.sessionId ?? null);

  // The sidebar renders sessions off the `entries` (workspaces) feed, so resolve
  // the active repo from the SAME source to keep server-session ids consistent.
  const activeRepo = useMemo<RepoSummary | null>(
    () => entries.flatMap((e) => e.repos).find((r) => r.name === repo) ?? null,
    [entries, repo],
  );
  const serverSessions = activeRepo?.sessions ?? EMPTY_SESSIONS;

  // The active diff's own session, stabilized so a benign refetch re-creating the
  // RepoDiff (and a fresh `scope` object) doesn't churn the sidebar's session memo.
  // The session id is sha256(kind+baseRef+headRef), so an equal id guarantees an
  // equal symbolic scope; only `baseSha` (commit drift) and `target` (the raw
  // spec, e.g. `a..b` vs `a...b`) can differ for one id. baseSha is unused by the
  // label or navigation, but `target` drives re-selection (selectSession →
  // setTarget), so we re-key the cache on it too — keeping identity stable while
  // (id, worktree, target) hold, and refreshing the scope when any of them move.
  const diffSessionId = diff?.sessionId ?? null;
  const diffSessionRef = useRef<ReviewSession | null>(null);
  if (diffSessionId && diff?.scope) {
    const cur = diffSessionRef.current;
    if (
      !cur ||
      cur.id !== diffSessionId ||
      cur.worktree !== worktree ||
      cur.scope.target !== diff.scope.target
    ) {
      diffSessionRef.current = { id: diffSessionId, scope: diff.scope, worktree };
    }
  } else if (diffSessionRef.current) {
    diffSessionRef.current = null;
  }
  const diffSession = diffSessionRef.current;

  // The set of worktree names currently checked out, used to drop a thread's
  // stored worktree if it has since been removed (selecting it would otherwise
  // 404 the diff route, which keeps a truthy worktree). Stable kinds round-trip
  // to the same id regardless of worktree, so falling back to the primary keeps
  // the thread reachable.
  const liveWorktrees = useMemo(
    () => new Set((activeRepo?.worktrees ?? []).map((w) => w.name)),
    [activeRepo],
  );

  // The archived-session list: the durable set (from the per-repo log, on the
  // workspace summary, carrying each session's scope) with optimistic overrides
  // folded in. Off-checkout sessions live here by their stored id/scope — never
  // re-derived, since re-derivation needs the live branch, which may have moved.
  // Drives the "complete" suggestion (an archived session never re-suggests) and
  // the sidebar's Archived group.
  const archivedSessions = useMemo<ReviewSession[]>(() => {
    const byId = new Map<string, ReviewSession>();
    for (const a of activeRepo?.archivedSessions ?? EMPTY_ARCHIVED) {
      byId.set(a.sessionId, { id: a.sessionId, scope: a.scope, worktree: null });
    }
    for (const [id, ov] of archiveOverrides) {
      if (ov.repo !== repo) continue; // a foreign repo's pin never shows here
      if (ov.archived) byId.set(id, ov.session);
      else byId.delete(id);
    }
    return byId.size ? [...byId.values()] : EMPTY_SESSIONS;
  }, [activeRepo, archiveOverrides, repo]);
  const archivedSet = useMemo(
    () => new Set(archivedSessions.map((s) => s.id)),
    [archivedSessions],
  );
  // Retire optimistic overrides the server view has caught up to, so a later
  // server-side flip (e.g. a teammate revives) isn't masked by a stale local pin.
  useEffect(() => {
    const serverArchived = new Set(
      (activeRepo?.archivedSessions ?? EMPTY_ARCHIVED).map((a) => a.sessionId),
    );
    setArchiveOverrides((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map(prev);
      for (const [id, ov] of prev) {
        // Only reconcile against the repo this override came from — serverArchived
        // is the active repo's set, so a foreign pin would always "disagree" and be
        // wrongly dropped (or kept). It retires when the user returns to its repo.
        if (ov.repo !== repo) continue;
        if (serverArchived.has(id) === ov.archived) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activeRepo, repo]);

  // Sessions not server-derived but still reachable: reconstructed from threads'
  // stored scopes (so a range/staged review you've commented on stays a sidebar
  // entry after you navigate away), plus the active diff's own scope (so a fresh
  // review with no threads yet is selectable). Only *stable* kinds are
  // reconstructed — `work`/`ref` ids depend on the live branch, so a stored one
  // for a branch no longer checked out can't round-trip (see STABLE_KINDS). The
  // active diff is exempt only because it IS the live resolution (its id is
  // whatever the route just stamped), so selecting it re-stamps the same id.
  // Tradeoff (Decision #3): a `work`/`ref` review you commented on but aren't
  // currently viewing has no sidebar entry until you re-target it — its threads
  // aren't lost (still in the log, counted), just not surfaced as a session.
  // All deduped by id against the server set and each other.
  const extraSessions = useMemo<ReviewSession[]>(() => {
    if (!repo) return EMPTY_SESSIONS;
    const serverIds = new Set(serverSessions.map((s) => s.id));
    const byId = new Map<string, ReviewSession>();
    for (const t of threads) {
      if (t.repo !== repo || t.sessionId === null || t.scope === null) continue;
      if (!STABLE_KINDS.has(t.scope.kind)) continue;
      if (serverIds.has(t.sessionId) || byId.has(t.sessionId)) continue;
      const worktree =
        t.worktree !== null && !liveWorktrees.has(t.worktree) ? null : t.worktree;
      byId.set(t.sessionId, { id: t.sessionId, scope: t.scope, worktree });
    }
    if (
      diffSession &&
      !serverIds.has(diffSession.id) &&
      !byId.has(diffSession.id)
    ) {
      byId.set(diffSession.id, diffSession);
    }
    return byId.size ? [...byId.values()] : EMPTY_SESSIONS;
  }, [repo, threads, serverSessions, diffSession, liveWorktrees]);

  // Thread count per session id (and the legacy bucket) over ALL the repo's
  // threads — the sidebar badge reads "how many comments live under this review",
  // independent of which session is currently shown.
  const sessionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of threads) {
      if (t.repo !== repo) continue;
      const key = t.sessionId ?? LEGACY_KEY;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [threads, repo]);
  const legacyCount = sessionCounts.get(LEGACY_KEY) ?? 0;

  // Open-thread count per session — the open-only sibling of `sessionCounts`. The
  // "looks complete" suggestion fires when a session has comments but none open,
  // so it needs the open tally kept apart from the total.
  const openCountsBySession = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of threads) {
      if (t.repo !== repo || t.status !== "open") continue;
      const key = t.sessionId ?? LEGACY_KEY;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [threads, repo]);

  // The settled session the user is looking at — the one "Mark complete" would
  // archive. Only the diff's own settled session qualifies: not mid-selection (the
  // threads on screen still belong to the previous session) and not the unscoped
  // bucket (not a session; its null scope the server refuses anyway). It carries
  // the scope the archive POST needs.
  const completableSession =
    !showUnscoped && !pendingSession ? diffSession : null;
  // Detection keyed on review *activity*, not tree state (plan/critic fix #1): this
  // review collected at least one comment, every one is now resolved, it isn't
  // already archived, and its suggestion hasn't been dismissed.
  const sessionDone =
    completableSession !== null &&
    (sessionCounts.get(completableSession.id) ?? 0) > 0 &&
    (openCountsBySession.get(completableSession.id) ?? 0) === 0 &&
    !archivedSet.has(completableSession.id) &&
    !dismissedComplete.has(completableSession.id);
  const markComplete = useCallback(() => {
    if (completableSession) void setArchived(completableSession, true);
  }, [completableSession, setArchived]);

  const scopedThreads = useMemo(
    () =>
      threads.filter((t) => {
        if (t.repo !== repo) return false;
        // The unscoped bucket shows pre-scope (v1) threads and nothing else;
        // session views show their own session and never the legacy threads.
        if (showUnscoped) return t.sessionId === null;
        if (t.sessionId === null) return false;
        return t.sessionId === currentSession;
      }),
    [threads, repo, showUnscoped, currentSession],
  );
  // Iterations of the active session, derived purely from the threads on screen:
  // one group per distinct snapshot a thread was filed against, plus the live
  // snapshot if no thread sits on it yet. Ordered by first-comment time so the
  // oldest iteration is "Iteration 1"; the live one is flagged "Current". This is
  // an informational timeline — there is no persisted snapshot history to read.
  const snapshotGroups = useMemo<SnapshotGroup[]>(() => {
    const byId = new Map<string, { id: string; count: number; firstAt: string }>();
    for (const t of scopedThreads) {
      if (t.snapshotId === null) continue;
      const g = byId.get(t.snapshotId);
      if (!g) byId.set(t.snapshotId, { id: t.snapshotId, count: 1, firstAt: t.createdAt });
      else {
        g.count++;
        if (t.createdAt < g.firstAt) g.firstAt = t.createdAt;
      }
    }
    const live = diff?.currentSnapshotId ?? null;
    if (live && !byId.has(live)) byId.set(live, { id: live, count: 0, firstAt: "" });
    const ordered = [...byId.values()].sort((a, b) => {
      if (a.firstAt === b.firstAt) return 0;
      if (!a.firstAt) return 1; // live with no threads yet sorts last
      if (!b.firstAt) return -1;
      return a.firstAt < b.firstAt ? -1 : 1;
    });
    return ordered.map((g, i) => ({
      id: g.id,
      count: g.count,
      ordinal: i + 1,
      firstAt: g.firstAt || null,
      isCurrent: g.id === live,
    }));
  }, [scopedThreads, diff?.currentSnapshotId]);
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
  // One stable closure for "back to diff" so it doesn't defeat memo() on the
  // heavy DiffView/Sidebar panels — a fresh arrow each render made them
  // re-run on every scroll-spy active-file tick, resize commit, and filter click.
  const backToDiff = useCallback(() => setPreviewFile(null), []);

  // Header/sidebar derived counts — total diffstat, viewed progress, and the
  // per-file open-thread counts the sidebar tree badges read.
  const totalAdditions = useMemo(
    () => sidebarFiles.reduce((n, f) => n + f.additions, 0),
    [sidebarFiles],
  );
  const totalDeletions = useMemo(
    () => sidebarFiles.reduce((n, f) => n + f.deletions, 0),
    [sidebarFiles],
  );
  const viewedCount = useMemo(
    () => sidebarFiles.reduce((n, f) => (viewed.has(f.path) ? n + 1 : n), 0),
    [sidebarFiles, viewed],
  );
  const threadCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of scopedThreads) {
      if (t.file === null) continue;
      counts.set(t.file, (counts.get(t.file) ?? 0) + 1);
    }
    return counts;
  }, [scopedThreads]);

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
        onTarget={changeTarget}
        refs={refs}
        theme={theme}
        onToggleTheme={toggleTheme}
        density={density}
        onDensity={changeDensity}
        split={splitView}
        onToggleSplit={toggleSplitView}
        wrap={wrapLines}
        onToggleWrap={toggleWrapLines}
        additions={totalAdditions}
        deletions={totalDeletions}
        filesChanged={sidebarFiles.length}
        viewedCount={viewedCount}
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
              currentSession={currentSession}
              showUnscoped={showUnscoped}
              extraSessions={extraSessions}
              archivedSessions={archivedSessions}
              archivedIds={archivedSet}
              sessionCounts={sessionCounts}
              legacyCount={legacyCount}
              snapshotGroups={snapshotGroups}
              onSelectRepo={setRepo}
              onSelectSession={selectSession}
              onReviveSession={reviveSession}
              onSelectLegacy={selectLegacy}
              files={sidebarFiles}
              allFiles={allFiles}
              viewed={viewed}
              threadCounts={threadCounts}
              activeFile={activeFile}
              onSelectFile={selectFile}
              onShowDiff={backToDiff}
              onAddWorkspace={openAdd}
            />
            <div
              className="sidebar-resizer"
              onMouseDown={startSidebarResize}
              title="Drag to resize"
            />
          </>
        )}
        <CurrentSnapshotContext.Provider value={diff?.currentSnapshotId ?? null}>
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
            wrap={wrapLines}
            theme={theme}
            onToggleViewed={toggleViewed}
            previewFile={previewFile}
            onBackToDiff={backToDiff}
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
          {sessionDone && completableSession && (
            <div className="complete-banner" role="status">
              <Icon name="check" size={14} className="complete-icon" />
              <span className="complete-msg">
                Every comment here is resolved — this review looks complete.
              </span>
              <button
                type="button"
                className="complete-action"
                onClick={markComplete}
              >
                Mark complete
              </button>
              <button
                type="button"
                className="icon-btn complete-dismiss"
                aria-label="Dismiss suggestion"
                title="Dismiss"
                onClick={() => dismissComplete(completableSession.id)}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          )}
          {!showUnscoped && scopedThreads.length === 0 && legacyCount > 0 && (
            <button
              type="button"
              className="unscoped-hint"
              onClick={selectLegacy}
            >
              <Icon name="git-branch" size={14} />
              <span>
                {legacyCount} unscoped comment{legacyCount === 1 ? "" : "s"} from
                before reviews were branch-scoped — view them
              </span>
            </button>
          )}
          <ThreadList
            threads={byStatus}
            editors={editors}
            showRepo={false}
            onChanged={refreshThreads}
          />
        </aside>
        )}
        </main>
        </CurrentSnapshotContext.Provider>
      </div>
    </div>
  );
}
