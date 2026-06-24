import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DAEMON_EVENTS } from "@diffect/shared";
import type {
  ArchivedSession,
  DiffFile,
  RefList,
  RepoDiff,
  RepoSummary,
  ReviewSession,
  Thread,
  ThreadStatus,
  WorkspaceEntry,
  WorkspaceInfo,
  WorktreeSummary,
} from "@diffect/shared";
import { api } from "./api.js";
import { Icon } from "./icons.js";
import { getStoredTheme, setTheme, type Theme } from "./theme.js";
import { getStoredDensity, setDensity, type Density } from "./density.js";
import { getStored, removeStored, setStored } from "./storage.js";
import { deriveLifecycle, type Lifecycle } from "./lifecycle.js";
import { fileElementId, orderedDiffFiles } from "./fileTree.js";
import { CurrentSnapshotContext } from "./currentSnapshot.js";
import { usePaneLayout } from "./usePaneLayout.js";
import { useResizable } from "./useResizable.js";
import { ModuleSection } from "./components/ModuleSection.js";
import { ThreadList } from "./components/ThreadList.js";
import { Topbar, WorkspaceRail } from "./components/Topbar.js";
import { Sidebar } from "./components/Sidebar.js";
import { AddWorkspaceDialog } from "./components/AddWorkspaceDialog.js";
import { GeneralCommentForm } from "./components/GeneralCommentForm.js";

type StatusFilter = ThreadStatus | "all";
type GeneralCommentTarget = {
  targetLevel: "space" | "repo";
  repo: string | null;
  spacePath: string;
  worktree: string | null;
  target: string;
  label: string;
};
const STATUS_FILTERS: StatusFilter[] = ["open", "closed", "all"];
// Stable empty references so memoized children don't re-render on the null paths.
const EMPTY_FILES: DiffFile[] = [];
const EMPTY_SESSIONS: ReviewSession[] = [];
const EMPTY_ARCHIVED: ArchivedSession[] = [];
// Shared empty "viewed" set so a repo with no per-file state yet projects a
// stable reference (memoized panels don't churn on the empty path).
const EMPTY_VIEWED: ReadonlySet<string> = new Set();
// A repo's default review selection on first visit: its primary checkout, work target.
const DEFAULT_TARGET = "work";
interface DeepLinkSelection {
  repo: string | null;
  worktree: string | null;
  target: string;
}
interface StoredPlace {
  workspacePath: string | null;
  repo: string | null;
  worktree: string | null;
  target: string;
  file: string | null;
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
const PLACE_KEY = "diffect-place-v1";
function readStoredPlace(): StoredPlace {
  try {
    const parsed = JSON.parse(getStored(PLACE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") throw new Error("bad place");
    const place = parsed as Partial<Record<keyof StoredPlace, unknown>>;
    return {
      workspacePath: typeof place.workspacePath === "string" ? place.workspacePath : null,
      repo: typeof place.repo === "string" ? place.repo : null,
      worktree: typeof place.worktree === "string" ? place.worktree : null,
      target: typeof place.target === "string" ? place.target : DEFAULT_TARGET,
      file: typeof place.file === "string" ? place.file : null,
    };
  } catch {
    return { workspacePath: null, repo: null, worktree: null, target: DEFAULT_TARGET, file: null };
  }
}
// Per-session dismissal of the "looks complete" suggestion. This is a UI
// preference (correctly browser-local), unlike the archive *fact* itself, which
// is a durable shared event in the per-repo log. Entries are keyed by
// `${repo}:${sessionId}` so the same id surfaced from two repos doesn't share a
// dismissal (session ids aren't repo-qualified — isolation is client-side, per the
// plan's invariant).
const COMPLETE_DISMISS_KEY = "diffect-complete-dismissed-v2";
// The pre-multi-repo key stored bare session ids with no repo context, so it can't
// be faithfully promoted to the composite form — drop it (a previously-dismissed
// banner may resurface once, then re-dismiss into the new key).
const LEGACY_COMPLETE_DISMISS_KEY = "diffect-complete-dismissed";
function loadDismissedComplete(): Set<string> {
  try {
    removeStored(LEGACY_COMPLETE_DISMISS_KEY);
    const raw = getStored(COMPLETE_DISMISS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
// The session-count map key standing in for legacy (pre-scope, sessionId === null)
// threads, which share the dedicated unscoped bucket rather than any one session.
const LEGACY_KEY = "__legacy__";
// Signature of a (worktree, target) selection — the cache key the diff fan-out
// dedupes on, so scroll-focus promoting a repo to active doesn't refetch a module
// whose selection is already loaded.
const selSig = (worktree: string | null, target: string) =>
  `${worktree ?? ""}::${target}`;
// Shallow set equality so re-reading a repo's stored "viewed" set preserves the
// existing reference when nothing changed — the memoized modules don't churn.
function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
// CSS.escape guard for the rare attribute selector (a repo name with a quote or
// backslash); falls back to the raw string where CSS.escape is unavailable.
function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s;
}
function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? p;
}
function selectedWorktreeSummary(
  repo: RepoSummary,
  worktree: string | null,
): WorktreeSummary | null {
  if (worktree) return repo.worktrees.find((w) => w.name === worktree) ?? null;
  return repo.worktrees.find((w) => w.root === repo.root) ?? repo.worktrees[0] ?? null;
}
// Stable empty thread array so a repo with no scoped threads projects a constant
// reference (the memoized module / inbox don't re-render on the empty path).
const EMPTY_THREADS: Thread[] = [];

export function App() {
  const [initialDeepLink] = useState(readInitialDeepLink);
  const [initialPlace] = useState(readStoredPlace);
  const initialRepo = initialDeepLink.repo ?? initialPlace.repo;
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [repo, setRepo] = useState<string | null>(initialRepo);
  const [activeWorkspacePath, setActiveWorkspacePath] = useState<string | null>(
    initialDeepLink.repo ? null : initialPlace.workspacePath,
  );
  // Per-repo review selection (checkout + target), so each stacked module keeps
  // its own base..compare independently. The active repo's entry is projected to
  // the `worktree`/`target` scalars below, which the rest of the component reads
  // unchanged. A repo absent from the map renders its first-visit default
  // (primary checkout, work target) via that projection.
  const [selections, setSelections] = useState<
    Map<string, { worktree: string | null; target: string }>
  >(() => {
    const m = new Map<string, { worktree: string | null; target: string }>();
    if (initialRepo) {
      m.set(initialRepo, {
        worktree: initialDeepLink.repo ? initialDeepLink.worktree : initialPlace.worktree,
        target: initialDeepLink.repo ? initialDeepLink.target : initialPlace.target,
      });
    }
    return m;
  });
  // Per-repo: which repos have their unscoped/legacy bucket open (the thread pane
  // shows pre-scope, sessionId === null threads instead of the active session's). A
  // flag-set keyed by repo, not a magic target, so it never collides with a real
  // review scope. The active repo projects to the `showUnscoped` scalar below, so a
  // stacked module's bucket state is its own and switching repos restores it rather
  // than bleeding across — the same per-repo persistence model as `selections`.
  const [showUnscopedByRepo, setShowUnscopedByRepo] = useState<
    Map<string, boolean>
  >(() => new Map());
  // Per-repo optimistic session highlight: the id we *expect* each repo's diff route
  // to stamp for the row just clicked, shown until that repo's diff settles. Keyed
  // by repo so an in-flight selection in one module never highlights another; the
  // active repo projects to the `pendingSession` scalar below. Fix 1 guarantees every
  // selectable entry round-trips, so it never lingers on a mismatch; `refreshDiffFor`
  // retires the entry on settle — success OR error — so an errored route can't strand
  // the highlight on a session that won't load.
  const [pendingByRepo, setPendingByRepo] = useState<
    Map<string, string | null>
  >(() => new Map());
  const [threadSessionByRepo, setThreadSessionByRepo] = useState<
    Map<string, string | null>
  >(() => new Map());
  // Bumped on every sidebar selection to force a diff reload even when the
  // resulting (worktree, target) equals the current one. Without it, re-selecting
  // the active session is a state no-op: no fetch fires, so the optimistic
  // `pendingSession` set below never gets a settle to retire it — and a session
  // whose diff previously errored could never be retried by re-clicking its row.
  const [reselectTick, setReselectTick] = useState(0);
  // Per-repo diff + refs, fetched and cached independently so switching/stacking
  // modules doesn't refetch or cross-contaminate. Projected to `diff`/`refs` for
  // the active repo below.
  const [diffs, setDiffs] = useState<Map<string, RepoDiff>>(() => new Map());
  const [refsByRepo, setRefsByRepo] = useState<Map<string, RefList>>(
    () => new Map(),
  );
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [filter, setFilter] = useState<StatusFilter>("open");
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);
  const [density, setDensityState] = useState<Density>(getStoredDensity);
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(initialPlace.file);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [workspaceRailOpen, setWorkspaceRailOpen] = useState(false);
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
  const [generalComment, setGeneralComment] = useState<GeneralCommentTarget | null>(null);
  // Per-repo per-file "viewed" sets, projected to `viewed` for the active repo.
  const [viewedByRepo, setViewedByRepo] = useState<Map<string, Set<string>>>(
    () => new Map(),
  );
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
  // Which repos render collapsed in the stacked layout. Lifted out of the module
  // so the repo rail's caret and its Collapse-all/Expand-all can drive the same
  // state the in-module caret does. A repo absent from the set is expanded — the
  // default — so an empty set (the N=1 case, where this is never read) means "all
  // open", matching the module's prior local `useState(false)`.
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(
    () => new Set(),
  );
  const diffPaneRef = useRef<HTMLElement>(null);
  const workbenchRef = useRef<HTMLDivElement>(null);
  const programmaticRepoRef = useRef<string | null>(null);
  const programmaticRepoTimerRef = useRef<number | null>(null);

  // Active-repo projection of the per-repo maps. Every reader below (memos,
  // effects, render, child props) uses these scalars exactly as before the lift,
  // so the single-repo path is the literal N=1 case of the per-repo collections.
  const selection = repo ? selections.get(repo) : undefined;
  const worktree = selection?.worktree ?? null;
  const target = selection?.target ?? DEFAULT_TARGET;
  const diff = (repo ? diffs.get(repo) : undefined) ?? null;
  const refs = (repo ? refsByRepo.get(repo) : undefined) ?? null;
  const viewed = ((repo ? viewedByRepo.get(repo) : undefined) ??
    EMPTY_VIEWED) as Set<string>;
  const showUnscoped = repo ? (showUnscopedByRepo.get(repo) ?? false) : false;
  const pendingSession = repo ? (pendingByRepo.get(repo) ?? null) : null;
  const threadSession = repo ? (threadSessionByRepo.get(repo) ?? null) : null;

  // Latest workspace/selections for callbacks that must read current state without
  // subscribing to it (the SSE fan-out, the per-repo refreshers, the viewed
  // toggle). A ref keeps those callbacks stable so they neither tear down the
  // EventSource nor defeat the module memo on every selection change.
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const selectionsRef = useRef(selections);
  selectionsRef.current = selections;
  const activeEntry = useMemo(
    () =>
      entries.find((ws) => ws.path === activeWorkspacePath) ??
      entries.find((ws) => ws.repos.some((r) => r.name === repo)) ??
      null,
    [activeWorkspacePath, entries, repo],
  );
  const visibleRepos = activeEntry?.repos ?? workspace?.repos ?? [];
  const visibleWorkspace = useMemo<WorkspaceInfo | null>(
    () =>
      workspace
        ? {
            ...workspace,
            root: activeEntry?.path ?? workspace.root,
            repos: visibleRepos,
          }
        : null,
    [activeEntry?.path, visibleRepos, workspace],
  );
  const activeSpacePath = visibleWorkspace?.root ?? null;
  // N≥2 ⇒ the stacked "modules view" (one diff list per repo, sharing a scroll
  // container); N≤1 ⇒ the literal single pane. A presentational switch only: every
  // selector/effect below still treats the single repo as the N=1 case.
  const stacked = visibleRepos.length > 1;
  // Stable key over the repo *names* so the module scroll-spy re-subscribes when the
  // set of repos changes, but not when a diff/selection inside one does.
  const repoNamesKey = JSON.stringify(visibleRepos.map((r) => r.name));

  useEffect(() => {
    const workspacePath = activeEntry?.path ?? activeWorkspacePath ?? workspace?.root ?? null;
    if (!workspacePath && !repo && !activeFile) return;
    setStored(
      PLACE_KEY,
      JSON.stringify({ workspacePath, repo, worktree, target, file: activeFile }),
    );
  }, [activeEntry?.path, activeFile, activeWorkspacePath, repo, target, worktree, workspace?.root]);

  // Write the unscoped/pending session UI for a given repo; both no-op when the
  // value is unchanged so a redundant settle (e.g. clearing an already-clear pending
  // highlight) doesn't churn a fresh Map / re-render.
  const setUnscopedFor = useCallback((forRepo: string, open: boolean) => {
    setShowUnscopedByRepo((prev) =>
      (prev.get(forRepo) ?? false) === open
        ? prev
        : new Map(prev).set(forRepo, open),
    );
  }, []);
  const setPendingFor = useCallback((forRepo: string, id: string | null) => {
    setPendingByRepo((prev) =>
      (prev.get(forRepo) ?? null) === id ? prev : new Map(prev).set(forRepo, id),
    );
  }, []);
  const setThreadSessionFor = useCallback((forRepo: string, id: string | null) => {
    setThreadSessionByRepo((prev) =>
      (prev.get(forRepo) ?? null) === id ? prev : new Map(prev).set(forRepo, id),
    );
  }, []);

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
  const toggleWorkspaceRail = () => setWorkspaceRailOpen((open) => !open);
  const closeWorkspaceRail = useCallback(() => setWorkspaceRailOpen(false), []);

  const loadWorkspaces = useCallback(() => {
    api.workspaces().then(setEntries).catch(() => setEntries([]));
  }, []);

  const selectFile = useCallback(
    (path: string) => {
      const match = diff?.files.find((f) => f.path === path || f.oldPath === path);
      const scrollPath = match?.path ?? path;
      setActiveFile(scrollPath);
      if (match && repo) {
        setPreviewFile(null);
        document
          .getElementById(fileElementId(repo, scrollPath))
          ?.scrollIntoView({ block: "start" });
      } else {
        setPreviewFile(path);
        diffPaneRef.current?.scrollTo({ top: 0 });
      }
    },
    [diff, repo],
  );

  const scrollThreadIntoView = useCallback((threadId: string) => {
    let attempts = 0;
    const findAndScroll = () => {
      const el = diffPaneRef.current?.querySelector<HTMLElement>(
        `.inline-thread[data-thread-id="${cssEscape(threadId)}"]`,
      );
      if (el) {
        el.scrollIntoView({ block: "center" });
        return;
      }
      attempts += 1;
      if (attempts < 12) window.setTimeout(findAndScroll, 80);
    };
    requestAnimationFrame(findAndScroll);
  }, []);

  const navigateToThread = useCallback(
    (thread: Thread) => {
      if (!thread.file) return;
      const threadRepo = thread.repo ?? repo;
      if (!threadRepo) return;
      const threadDiff = diffs.get(threadRepo) ?? (threadRepo === repo ? diff : null);
      const match = threadDiff?.files.find(
        (f) => f.path === thread.file || f.oldPath === thread.file,
      );
      const scrollPath = match?.path ?? thread.file;

      setRepo(threadRepo);
      setActiveFile(scrollPath);
      if (match) {
        setPreviewFile(null);
        document
          .getElementById(fileElementId(threadRepo, scrollPath))
          ?.scrollIntoView({ block: "start" });
      } else {
        setPreviewFile(thread.file);
        diffPaneRef.current?.scrollTo({ top: 0 });
      }
      scrollThreadIntoView(thread.id);
    },
    [diff, diffs, repo, scrollThreadIntoView],
  );

  // Selecting a repo (sidebar click) promotes it to active and, in the stacked
  // layout, scrolls its module into view; the module scroll-spy then keeps `repo`
  // in sync as the user scrolls. At N=1 there's one module already in view, so the
  // scroll is a no-op and this is just `setRepo`.
  const selectRepo = useCallback((name: string) => {
    programmaticRepoRef.current = name;
    if (programmaticRepoTimerRef.current !== null) {
      window.clearTimeout(programmaticRepoTimerRef.current);
    }
    setRepo(name);
    setReselectTick((n) => n + 1);
    diffPaneRef.current
      ?.querySelector(`.module[data-repo="${cssEscape(name)}"]`)
      ?.scrollIntoView({ block: "start" });
    programmaticRepoTimerRef.current = window.setTimeout(() => {
      if (programmaticRepoRef.current === name) programmaticRepoRef.current = null;
      programmaticRepoTimerRef.current = null;
    }, 350);
  }, []);
  const selectWorkspace = useCallback(
    (path: string) => {
      setActiveWorkspacePath(path);
      const firstRepo = entries.find((ws) => ws.path === path)?.repos[0]?.name;
      if (firstRepo) selectRepo(firstRepo);
    },
    [entries, selectRepo],
  );

  useEffect(() => {
    if (!activeEntry || (repo && activeEntry.repos.some((r) => r.name === repo))) return;
    const firstRepo = activeEntry.repos[0]?.name;
    if (firstRepo) setRepo(firstRepo);
  }, [activeEntry, repo]);
  const initialDeepLinkScrolled = useRef(false);
  useEffect(() => {
    const name = initialDeepLink.repo;
    if (!name || initialDeepLinkScrolled.current) return;
    if (!workspace?.repos.some((r) => r.name === name)) return;
    initialDeepLinkScrolled.current = true;
    requestAnimationFrame(() => {
      diffPaneRef.current
        ?.querySelector(`.module[data-repo="${cssEscape(name)}"]`)
        ?.scrollIntoView({ block: "start" });
    });
  }, [initialDeepLink.repo, workspace]);

  // Collapse controls for the stacked layout, shared by each module's caret.
  const toggleCollapseFor = useCallback((forRepo: string) => {
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(forRepo)) next.delete(forRepo);
      else next.add(forRepo);
      return next;
    });
  }, []);

  // Per-file "viewed" state, scoped per repo to that repo's (worktree, target) —
  // the diff's identity — and persisted under one key each. The key is computed
  // from a repo's own selection, not a single active-repo key, so a stacked module
  // reads and writes its own set.
  const viewedKeyFor = useCallback(
    (forRepo: string, sel: { worktree: string | null; target: string }) =>
      `diffect-viewed:${forRepo}:${sel.worktree ?? ""}:${sel.target}`,
    [],
  );
  // Load every repo's stored viewed set for its current selection. `sameSet`
  // preserves the existing reference when a repo's set is unchanged so the memoized
  // modules don't churn. At N=1 this is the single active repo — the old behavior.
  useEffect(() => {
    if (!workspace) return;
    setViewedByRepo((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const r of visibleRepos) {
        const sel = selections.get(r.name) ?? {
          worktree: null,
          target: DEFAULT_TARGET,
        };
        let loaded: Set<string>;
        try {
          const raw = getStored(viewedKeyFor(r.name, sel));
          loaded = new Set(raw ? (JSON.parse(raw) as string[]) : []);
        } catch {
          loaded = new Set();
        }
        const cur = prev.get(r.name);
        if (!cur || !sameSet(cur, loaded)) {
          next.set(r.name, loaded);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [workspace, visibleRepos, selections, viewedKeyFor]);

  // Toggle "viewed" for a file in a SPECIFIC repo (a stacked module passes its own
  // repo, so a click writes the right set even if scroll-focus hasn't yet promoted
  // it to active). Reads the repo's selection from the ref so the callback stays
  // stable and doesn't defeat the module memo.
  const toggleViewedFor = useCallback(
    (forRepo: string, path: string) => {
      const sel = selectionsRef.current.get(forRepo) ?? {
        worktree: null,
        target: DEFAULT_TARGET,
      };
      setViewedByRepo((prevMap) => {
        const next = new Set(prevMap.get(forRepo) ?? EMPTY_VIEWED);
        next.has(path) ? next.delete(path) : next.add(path);
        setStored(viewedKeyFor(forRepo, sel), JSON.stringify([...next]));
        return new Map(prevMap).set(forRepo, next);
      });
    },
    [viewedKeyFor],
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
  // Per-repo monotonic diff tokens (last-issued-wins per module, so a slow repo
  // can't clobber a fast one) now that N repos fetch in parallel.
  const diffSeqs = useRef<Map<string, number>>(new Map());
  // Per-repo signature of the last *successfully loaded* selection, so the fan-out
  // effect skips a module whose (worktree, target) is unchanged — scroll-focus
  // promoting a repo to active must not refetch it.
  const loadedSelRef = useRef<Map<string, string>>(new Map());
  // The reselectTick the fan-out last acted on, so re-clicking the active repo's
  // row (which bumps the tick without changing the selection) still forces exactly
  // that repo to refetch.
  const lastReselectRef = useRef(reselectTick);
  // Per-repo refs tokens + last-loaded worktree signature, mirroring the diff
  // fan-out: each module's compare picker needs its own repo's refs, fetched in
  // parallel and cached. The signature is set on success only, so a dropped/failed
  // load retries on the next fan-out pass instead of being skipped as loaded.
  const refsSeqs = useRef<Map<string, number>>(new Map());
  const loadedRefsRef = useRef<Map<string, string>>(new Map());

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

  // Refresh ONE repo's diff for an explicit selection. A per-repo seq token guards
  // against a stale response landing after a newer one; on settle (success OR
  // error) it retires that repo's optimistic highlight, and on success records the
  // loaded selection signature so the fan-out won't refetch it on scroll.
  const refreshDiffFor = useCallback(
    async (
      forRepo: string,
      sel: { worktree: string | null; target: string },
    ) => {
      const seq = (diffSeqs.current.get(forRepo) ?? 0) + 1;
      diffSeqs.current.set(forRepo, seq);
      try {
        const next = await api.diff(forRepo, {
          worktree: sel.worktree,
          target: sel.target,
        });
        if (seq === diffSeqs.current.get(forRepo)) {
          setDiffs((prev) => new Map(prev).set(forRepo, next));
          setError(null);
          loadedSelRef.current.set(forRepo, selSig(sel.worktree, sel.target));
          setPendingFor(forRepo, null);
        }
      } catch (e) {
        if (seq === diffSeqs.current.get(forRepo)) {
          setError(String(e));
          // Settled with an error (deleted base ref → 500, removed worktree → 404).
          // Retire the optimistic highlight so it can't pin the sidebar/filter to a
          // session whose diff never loads; leave loadedSelRef unset so a re-click
          // (reselectTick) retries instead of being skipped as already-loaded.
          setPendingFor(forRepo, null);
        }
      }
    },
    [setPendingFor],
  );
  // Refresh every repo's diff against its current selection — the SSE diff.changed
  // fan-out (events carry no repo, so any module may have changed). Reads the
  // latest workspace/selections from refs so it stays stable across selections.
  const refreshAllDiffs = useCallback(() => {
    for (const r of workspaceRef.current?.repos ?? []) {
      const sel = selectionsRef.current.get(r.name) ?? {
        worktree: null,
        target: DEFAULT_TARGET,
      };
      void refreshDiffFor(r.name, sel);
    }
  }, [refreshDiffFor]);

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

  // (Switching repos no longer resets the unscoped bucket or optimistic highlight:
  // both are now per-repo (`showUnscopedByRepo`/`pendingByRepo`), so entering a repo
  // reads its own entry — a first visit projects to closed/none — and returning to
  // one restores it, exactly as `selections` already does. There is no cross-repo
  // bleed left to wipe, and stacking (Lift C) needs each module's state to persist.)

  // Picking a target navigates one module to a real diff/session, so it must also
  // leave that repo's unscoped bucket (which overrides the thread filter). We can't
  // predict the resulting session id from the target alone, so drop any optimistic
  // highlight and let the landing diff settle it. The checkout is preserved — only
  // the target changes. Repo-parameterized so each stacked module retargets itself.
  const changeTargetFor = useCallback(
    (forRepo: string, next: string) => {
      setUnscopedFor(forRepo, false);
      setPendingFor(forRepo, null);
      setThreadSessionFor(forRepo, null);
      setSelections((prev) =>
        new Map(prev).set(forRepo, {
          worktree: prev.get(forRepo)?.worktree ?? null,
          target: next,
        }),
      );
    },
    [setUnscopedFor, setPendingFor, setThreadSessionFor],
  );
  const selectLegacy = useCallback(() => {
    if (!repo) return;
    setPendingFor(repo, null);
    setThreadSessionFor(repo, null);
    setUnscopedFor(repo, true);
  }, [repo, setPendingFor, setThreadSessionFor, setUnscopedFor]);

  const selectReviewSession = useCallback(
    (session: ReviewSession) => {
      if (!repo) return;
      setUnscopedFor(repo, false);
      setPendingFor(repo, null);
      setThreadSessionFor(repo, session.id);
      setFilter("all");
      if (paneCollapsed) toggleCollapsed();
    },
    [paneCollapsed, repo, setPendingFor, setThreadSessionFor, setUnscopedFor, toggleCollapsed],
  );

  // Archive (`archived: true`) or revive (`archived: false`) a session. Optimistic:
  // record the override so the banner/sidebar flip immediately, POST the scope (the
  // server re-derives the id), and roll the override back if the write fails. The
  // SSE `workspace.changed` broadcast refetches the durable set, which the
  // reconciler below then folds in, retiring the override.
  // Repo-parameterized so a stacked module archives/revives its OWN session even
  // when it isn't the focused repo. The override carries `forRepo`, so the
  // reconciler retires it against that repo's server set, never the active one's.
  const setArchivedFor = useCallback(
    async (forRepo: string, session: ReviewSession, archived: boolean) => {
      setArchiveOverrides((prev) =>
        new Map(prev).set(session.id, { archived, session, repo: forRepo }),
      );
      try {
        await api.archiveSession(forRepo, { scope: session.scope, archived });
      } catch (e) {
        setError(String(e));
        setArchiveOverrides((prev) => {
          const next = new Map(prev);
          next.delete(session.id);
          return next;
        });
      }
    },
    [],
  );
  // Active-repo archive — the N=1 banner/sidebar path, unchanged: delegates to the
  // repo-parameterized form bound to the active repo (a no-op when none is active).
  const setArchived = useCallback(
    (session: ReviewSession, archived: boolean) => {
      if (!repo) return;
      void setArchivedFor(repo, session, archived);
    },
    [repo, setArchivedFor],
  );
  // Dismissals are keyed by `${repo}:${sessionId}` so the same session id surfaced
  // from two repos doesn't share a dismissal (ids aren't repo-qualified).
  const dismissComplete = useCallback(
    (id: string) => {
      if (!repo) return;
      setDismissedComplete((prev) => {
        const next = new Set(prev).add(`${repo}:${id}`);
        setStored(COMPLETE_DISMISS_KEY, JSON.stringify([...next]));
        return next;
      });
    },
    [repo],
  );

  useEffect(() => {
    setPreviewFile(null);
  }, [repo, worktree, target]);

  // Refresh ONE repo's refs (branches/tags/commits/remotes) for its compare
  // picker. A per-repo seq token guards against a stale response landing late; the
  // loaded-worktree signature is recorded on success so the fan-out skips the repo
  // until its checkout changes, and left unset on error so the next pass retries.
  const refreshRefsFor = useCallback(async (forRepo: string, wt: string | null) => {
    const seq = (refsSeqs.current.get(forRepo) ?? 0) + 1;
    refsSeqs.current.set(forRepo, seq);
    try {
      const next = await api.refs(forRepo, wt);
      if (seq === refsSeqs.current.get(forRepo)) {
        setRefsByRepo((prev) => new Map(prev).set(forRepo, next));
        loadedRefsRef.current.set(forRepo, wt ?? "");
      }
    } catch {
      if (seq === refsSeqs.current.get(forRepo)) {
        setRefsByRepo((prev) => {
          if (!prev.has(forRepo)) return prev;
          const map = new Map(prev);
          map.delete(forRepo);
          return map;
        });
      }
    }
  }, []);
  // Fan-out refs fetch: every module loads its own repo's refs against its current
  // checkout, in parallel and cached independently — so each stacked module's
  // compare picker is populated, not just the active one's. A repo is skipped when
  // its worktree signature is unchanged. At N=1 this fetches the one repo on
  // checkout change, exactly as the active-only effect it replaced.
  useEffect(() => {
    if (!workspace) return;
    for (const r of visibleRepos) {
      const wt = selections.get(r.name)?.worktree ?? null;
      if (loadedRefsRef.current.get(r.name) === (wt ?? "")) continue;
      void refreshRefsFor(r.name, wt);
    }
  }, [workspace, visibleRepos, selections, refreshRefsFor]);

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

  // Fan-out diff fetch: each repo loads its own selection, in parallel and cached
  // independently. A module is skipped when its (worktree, target) is already
  // loaded — so scroll-focus promoting a repo to active never refetches it — UNLESS
  // a reselect tick targeted the active repo (re-clicking its row forces a retry).
  // At N=1 this reduces to "fetch the one repo on selection change / reselect."
  useEffect(() => {
    if (!workspace) return;
    const forced = lastReselectRef.current !== reselectTick;
    lastReselectRef.current = reselectTick;
    for (const r of visibleRepos) {
      const sel = selections.get(r.name) ?? {
        worktree: null,
        target: DEFAULT_TARGET,
      };
      const loaded = loadedSelRef.current.get(r.name) === selSig(sel.worktree, sel.target);
      const isFocused = r.name === repo;
      if (loaded && !(isFocused && forced)) continue;
      void refreshDiffFor(r.name, sel);
    }
  }, [workspace, visibleRepos, repo, selections, reselectTick, refreshDiffFor]);

  const sidebarFiles = useMemo(() => diff?.files ?? EMPTY_FILES, [diff]);
  // Render the diff in the same order the sidebar tree shows, so the active-file
  // highlight walks the tree top-to-bottom as you scroll instead of jumping.
  const orderedFiles = useMemo(() => orderedDiffFiles(sidebarFiles), [sidebarFiles]);
  // Files backing the topbar's aggregate diffstat + viewed progress. At N≥2 it's
  // every module's files (the header summarizes the whole modules view); at N=1
  // it's the single repo's — identical to `sidebarFiles`.
  const headerFiles = useMemo(
    () =>
      stacked
        ? visibleRepos.flatMap((r) => diffs.get(r.name)?.files ?? EMPTY_FILES)
        : sidebarFiles,
    [stacked, visibleRepos, diffs, sidebarFiles],
  );

  const restoredFileRef = useRef(false);
  useEffect(() => {
    if (restoredFileRef.current || !initialPlace.file || !diff || !repo) return;
    restoredFileRef.current = true;
    selectFile(initialPlace.file);
  }, [diff, initialPlace.file, repo, selectFile]);

  // Scroll-spy: highlight the file in the sidebar that's at the top of the diff
  // pane as the user scrolls, so the tree tracks reading position. Tracks the
  // active repo's files; the path is read back off `data-path` (the element id is
  // repo-qualified and both parts may contain hyphens). At N≥2 the shared `.modmain`
  // is the scroll root, observing the active module's file blocks.
  useEffect(() => {
    const root = diffPaneRef.current;
    if (!root || !diff || !repo || previewFile) return;
    const headers = diff.files
      .map((f) => document.getElementById(fileElementId(repo, f.path)))
      .filter((el): el is HTMLElement => el !== null);
    if (headers.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const path = top?.target.getAttribute("data-path");
        if (path) setActiveFile(path);
      },
      { root, rootMargin: "0px 0px -70% 0px", threshold: 0 },
    );
    headers.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [diff, repo, previewFile]);

  // Module scroll-spy (stacked layout only): as the shared container scrolls,
  // promote the topmost visible module to the active repo so the sidebar highlight,
  // repo header, and thread filter follow what's on screen. Keyed on the
  // repo-name set so it re-subscribes only when the set of repos changes.
  useEffect(() => {
    if (!stacked) return;
    const root = diffPaneRef.current;
    if (!root) return;
    const modules = Array.from(
      root.querySelectorAll<HTMLElement>(".module[data-repo]"),
    );
    if (modules.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const name = top?.target.getAttribute("data-repo");
        if (!name) return;
        const locked = programmaticRepoRef.current;
        if (locked && name !== locked) return;
        if (locked === name) {
          programmaticRepoRef.current = null;
          if (programmaticRepoTimerRef.current !== null) {
            window.clearTimeout(programmaticRepoTimerRef.current);
            programmaticRepoTimerRef.current = null;
          }
        }
        setRepo(name);
      },
      { root, rootMargin: "0px 0px -80% 0px", threshold: 0 },
    );
    modules.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [stacked, repoNamesKey]);

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
  const refreshers = useRef({ refreshThreads, refreshAllDiffs, refreshWorkspace, loadWorkspaces });
  refreshers.current = { refreshThreads, refreshAllDiffs, refreshWorkspace, loadWorkspaces };
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
        r.refreshAllDiffs();
        refreshWorkspaceSoon();
        setLive("Diff updated");
      } else if (type === DAEMON_EVENTS.workspaceChanged) {
        // Git HEAD/ref changes affect branch labels, PR links, and picker refs.
        loadedRefsRef.current.clear();
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
  const currentSession = !showUnscoped
    ? threadSession ?? pendingSession ?? (diff?.sessionId ?? null)
    : null;

  // The sidebar renders sessions off the `entries` (workspaces) feed, so resolve
  // the active repo from the SAME source to keep server-session ids consistent.
  const activeRepo = useMemo<RepoSummary | null>(
    () => entries.flatMap((e) => e.repos).find((r) => r.name === repo) ?? null,
    [entries, repo],
  );
  const activeWorktree = activeRepo
    ? selectedWorktreeSummary(activeRepo, worktree)
    : null;

  // The active diff's own session, stabilized so a benign refetch re-creating the
  // RepoDiff (and a fresh `scope` object) doesn't churn the sidebar's session memo.
  // The session id is sha256(kind+baseRef+headRef), so an equal id guarantees an
  // equal symbolic scope; only `baseSha` (commit drift) and `target` (the raw
  // spec, e.g. `a..b` vs `a...b`) can differ for one id. baseSha is unused by the
  // label or navigation, but `target` drives re-selection, so we re-key the cache
  // on it too — keeping identity stable while
  // (id, worktree, target) hold, and refreshing the scope when any of them move.
  const diffSessionId = diff?.sessionId ?? null;
  // Stabilized per repo: each module's diff carries its own session, cached so a
  // benign refetch (new RepoDiff/scope object, same id) doesn't churn the memos.
  // Keyed by repo so stacked modules never share or clobber each other's session;
  // an inactive repo whose diff cleared has its entry dropped, not the whole cache.
  const diffSessionsRef = useRef<Map<string, ReviewSession>>(new Map());
  if (repo) {
    if (diffSessionId && diff?.scope) {
      const cur = diffSessionsRef.current.get(repo);
      if (
        !cur ||
        cur.id !== diffSessionId ||
        cur.worktree !== worktree ||
        cur.scope.target !== diff.scope.target
      ) {
        diffSessionsRef.current.set(repo, {
          id: diffSessionId,
          scope: diff.scope,
          worktree,
        });
      }
    } else {
      diffSessionsRef.current.delete(repo);
    }
  }
  const diffSession = repo ? (diffSessionsRef.current.get(repo) ?? null) : null;

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
  // Each repo's durable archived-session id set, taken from the workspace summary
  // (every repo across entries). Feeds both the override reconciler and the
  // per-module status crumbs. At N=1 it's a single entry equal to the active
  // repo's set, so the reconciler below stays byte-identical to its prior form.
  const serverArchivedByRepo = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const r of entries.flatMap((e) => e.repos)) {
      map.set(
        r.name,
        new Set((r.archivedSessions ?? EMPTY_ARCHIVED).map((a) => a.sessionId)),
      );
    }
    return map;
  }, [entries]);
  // Retire optimistic overrides the server view has caught up to, so a later
  // server-side flip (e.g. a teammate revives) isn't masked by a stale local pin.
  // Each override reconciles against ITS OWN repo's server set, so a background
  // module's pin retires as soon as that repo's durable event round-trips — not
  // only when the user focuses it. (At N=1 there's one repo; same as before.)
  useEffect(() => {
    setArchiveOverrides((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map(prev);
      for (const [id, ov] of prev) {
        const serverArchived = serverArchivedByRepo.get(ov.repo);
        if (!serverArchived) continue; // repo not in the workspace view yet
        if (serverArchived.has(id) === ov.archived) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [serverArchivedByRepo]);

  // Thread count per session id (and the legacy bucket) over ALL the repo's
  // threads — the sidebar badge reads "how many comments live under this review",
  // independent of which session is currently shown.
  const sessionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of threads) {
      if (t.spacePath && t.spacePath !== activeSpacePath) continue;
      if (t.repo !== repo) continue;
      const key = t.sessionId ?? LEGACY_KEY;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [threads, repo, activeSpacePath]);
  const legacyCount = sessionCounts.get(LEGACY_KEY) ?? 0;

  // Open-thread count per session — the open-only sibling of `sessionCounts`. The
  // "looks complete" suggestion fires when a session has comments but none open,
  // so it needs the open tally kept apart from the total.
  const openCountsBySession = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of threads) {
      if (t.spacePath && t.spacePath !== activeSpacePath) continue;
      if (t.repo !== repo || t.status !== "open") continue;
      const key = t.sessionId ?? LEGACY_KEY;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [threads, repo, activeSpacePath]);

  // The settled session the user is looking at — the one "Mark complete" would
  // archive. Only the diff's own settled session qualifies: not mid-selection (the
  // threads on screen still belong to the previous session) and not the unscoped
  // bucket (not a session; its null scope the server refuses anyway). It carries
  // the scope the archive POST needs.
  const completableSession =
    !showUnscoped && !pendingSession && !threadSession ? diffSession : null;
  // Detection keyed on review *activity*, not tree state (plan/critic fix #1): this
  // review collected at least one comment, every one is now resolved, it isn't
  // already archived, and its suggestion hasn't been dismissed.
  const sessionDone =
    completableSession !== null &&
    (sessionCounts.get(completableSession.id) ?? 0) > 0 &&
    (openCountsBySession.get(completableSession.id) ?? 0) === 0 &&
    !archivedSet.has(completableSession.id) &&
    !dismissedComplete.has(`${repo}:${completableSession.id}`);
  const markComplete = useCallback(() => {
    if (completableSession) void setArchived(completableSession, true);
  }, [completableSession, setArchived]);

  // Each repo's effective archived-session id set: its durable server set with
  // this repo's optimistic pins folded in, so a module's crumb flips the instant
  // its archive/revive POST fires (before the SSE round-trip). At N=1 the active
  // repo's entry equals `archivedSet`; the crumb only reads this when stacked.
  const archivedByRepo = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const [name, set] of serverArchivedByRepo) map.set(name, new Set(set));
    for (const [id, ov] of archiveOverrides) {
      let set = map.get(ov.repo);
      if (!set) {
        set = new Set();
        map.set(ov.repo, set);
      }
      if (ov.archived) set.add(id);
      else set.delete(id);
    }
    return map;
  }, [serverArchivedByRepo, archiveOverrides]);

  // The durable lifecycle state each module's status crumb renders, plus the
  // session that crumb's Mark complete / Revive acts on. Per repo it mirrors the
  // active-repo derivation: the module's settled session is the diff's own session
  // (unless showing the unscoped bucket or mid-selection); its total/open comment
  // tallies and archived flag then resolve to one of the four resting states. The
  // active repo's entry tracks `completableSession`, so the crumb and the N=1
  // banner never disagree about whether a review is ready.
  const lifecycleByRepo = useMemo(() => {
    const map = new Map<
      string,
      { state: Lifecycle; session: ReviewSession | null }
    >();
    for (const r of visibleRepos) {
      const name = r.name;
      const d = diffs.get(name) ?? null;
      const rShow = showUnscopedByRepo.get(name) ?? false;
      const rPending = pendingByRepo.get(name) ?? null;
      const session: ReviewSession | null =
        !rShow && !rPending && d?.sessionId && d.scope
          ? {
              id: d.sessionId,
              scope: d.scope,
              worktree: selections.get(name)?.worktree ?? null,
            }
          : null;
      if (!session) {
        map.set(name, { state: "idle", session: null });
        continue;
      }
      let total = 0;
      let open = 0;
      for (const t of threads) {
        if (t.spacePath && t.spacePath !== activeSpacePath) continue;
        if (t.repo !== name || t.sessionId !== session.id) continue;
        total++;
        if (t.status === "open") open++;
      }
      const archived = archivedByRepo.get(name)?.has(session.id) ?? false;
      map.set(name, {
        state: deriveLifecycle({
          totalComments: total,
          openComments: open,
          archived,
        }),
        session,
      });
    }
    return map;
  }, [
    visibleRepos,
    diffs,
    threads,
    showUnscopedByRepo,
    pendingByRepo,
    selections,
    archivedByRepo,
    activeSpacePath,
  ]);

  // Per-repo scoped thread lists: each repo's threads filtered to its own current
  // session (or its unscoped bucket). Built as a Map in one pass so the stacked
  // layout can both hand each module its own threads AND aggregate them for the
  // cross-repo inbox. Deps exclude the active `repo`/`activeFile`, so scrolling
  // between modules rebuilds nothing. At N=1 the map has one entry — the literal
  // old `scopedThreads`.
  const scopedThreadsByRepo = useMemo(() => {
    const map = new Map<string, Thread[]>();
    for (const r of visibleRepos) {
      const rShow = showUnscopedByRepo.get(r.name) ?? false;
      const rPending = pendingByRepo.get(r.name) ?? null;
      const rThreadSession = threadSessionByRepo.get(r.name) ?? null;
      // Mirror the active-repo `currentSession` derivation, per repo.
      const rSession = !rShow
        ? rThreadSession ?? rPending ?? (diffs.get(r.name)?.sessionId ?? null)
        : null;
      map.set(
        r.name,
        threads.filter((t) => {
          if (t.spacePath && t.spacePath !== activeSpacePath) return false;
          if (t.repo !== r.name) return false;
          // The unscoped bucket shows pre-scope (v1) threads and nothing else;
          // session views show their own session and never the legacy threads.
          if (rShow) return t.sessionId === null;
          if (t.sessionId === null) return false;
          return t.sessionId === rSession;
        }),
      );
    }
    return map;
  }, [
    threads,
    visibleRepos,
    showUnscopedByRepo,
    pendingByRepo,
    threadSessionByRepo,
    diffs,
    activeSpacePath,
  ]);
  // Active repo's scoped threads — byte-identical to the pre-lift `scopedThreads`
  // (its internal rSession for the active repo equals `currentSession`). Drives the
  // active-repo views: the iteration timeline, the per-file thread badges, the
  // legacy hint, and the sidebar.
  const scopedThreads =
    (repo ? scopedThreadsByRepo.get(repo) : undefined) ?? EMPTY_THREADS;
  const spaceThreads = useMemo(
    () =>
      activeSpacePath
        ? threads.filter(
            (t) => t.targetLevel === "space" && t.spacePath === activeSpacePath,
          )
        : EMPTY_THREADS,
    [threads, activeSpacePath],
  );
  // Threads the visible diff surface owns: space-level comments plus, at N≥2, the
  // union across all modules; at N=1, the active repo's scoped comments.
  const paneThreads = useMemo(
    () => [
      ...spaceThreads,
      ...(stacked
        ? visibleRepos.flatMap((r) => scopedThreadsByRepo.get(r.name) ?? EMPTY_THREADS)
        : scopedThreads),
    ],
    [spaceThreads, stacked, visibleRepos, scopedThreadsByRepo, scopedThreads],
  );
  const byStatus = useMemo(
    () =>
      filter === "all"
        ? paneThreads
        : paneThreads.filter((t) => t.status === filter),
    [paneThreads, filter],
  );
  const statusCounts = useMemo<Record<StatusFilter, number>>(
    () => ({
      open: paneThreads.filter((t) => t.status === "open").length,
      closed: paneThreads.filter((t) => t.status === "closed").length,
      all: paneThreads.length,
    }),
    [paneThreads],
  );
  const openAdd = useCallback(() => setAddOpen(true), []);
  const openRepoComment = useCallback(
    (repoName: string) => {
      if (!visibleWorkspace) return;
      const sel = selections.get(repoName) ?? { worktree: null, target: DEFAULT_TARGET };
      setGeneralComment({
        targetLevel: "repo",
        repo: repoName,
        spacePath: visibleWorkspace.root,
        worktree: sel.worktree,
        target: sel.target,
        label: repoName,
      });
    },
    [selections, visibleWorkspace],
  );
  const openSpaceComment = useCallback(() => {
    if (!visibleWorkspace) return;
    setGeneralComment({
      targetLevel: "space",
      repo: null,
      spacePath: visibleWorkspace.root,
      worktree: null,
      target: DEFAULT_TARGET,
      label: basename(visibleWorkspace.root),
    });
  }, [visibleWorkspace]);
  const closeGeneralComment = useCallback(() => setGeneralComment(null), []);
  const generalCommentCreated = useCallback(() => {
    setGeneralComment(null);
    void refreshThreads();
  }, [refreshThreads]);
  // One stable closure for "back to diff" so it doesn't defeat memo() on the
  // heavy DiffView/Sidebar panels — a fresh arrow each render made them
  // re-run on every scroll-spy active-file tick, resize commit, and filter click.
  const backToDiff = useCallback(() => setPreviewFile(null), []);

  // Header/sidebar derived counts — total diffstat and the per-file open-thread
  // counts the sidebar tree badges read.
  const totalAdditions = useMemo(
    () => headerFiles.reduce((n, f) => n + f.additions, 0),
    [headerFiles],
  );
  const totalDeletions = useMemo(
    () => headerFiles.reduce((n, f) => n + f.deletions, 0),
    [headerFiles],
  );
  const threadCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of scopedThreads) {
      if (t.file === null) continue;
      counts.set(t.file, (counts.get(t.file) ?? 0) + 1);
    }
    return counts;
  }, [scopedThreads]);

  const changedFilesByRepo = useMemo(() => {
    const map = new Map<string, number>();
    for (const [name, d] of diffs) map.set(name, d.files.length);
    return map;
  }, [diffs]);

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

  if (!workspace || !visibleWorkspace || !repo) {
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
        workspace={visibleWorkspace}
        entries={entries}
        activeWorkspacePath={activeEntry?.path ?? visibleWorkspace.root}
        changedFilesByRepo={changedFilesByRepo}
        onSelectWorkspace={selectWorkspace}
        onAddWorkspace={openAdd}
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
        filesChanged={headerFiles.length}
        workspaceRailOpen={workspaceRailOpen}
        onToggleWorkspaceRail={toggleWorkspaceRail}
      />
      <div className="workbench" ref={workbenchRef} style={paneVars}>
        {workspaceRailOpen && (
          <WorkspaceRail
            workspace={visibleWorkspace}
            entries={entries}
            activeWorkspacePath={activeEntry?.path ?? visibleWorkspace.root}
            changedFilesByRepo={changedFilesByRepo}
            onSelectWorkspace={selectWorkspace}
            onAddWorkspace={openAdd}
            onClose={closeWorkspaceRail}
          />
        )}
        {sidebarCollapsed ? (
          <button
            type="button"
            className="sidebar-reopen"
            onClick={toggleSidebar}
            title="Show files sidebar"
            aria-label="Show files sidebar"
          >
            <Icon name="sidebar-expand" size={15} />
          </button>
        ) : (
          <>
            <Sidebar
              repo={repo}
              repos={visibleRepos}
              currentSession={currentSession}
              showUnscoped={showUnscoped}
              archivedSessions={archivedSessions}
              sessionCounts={sessionCounts}
              legacyCount={legacyCount}
              onSelectRepo={selectRepo}
              onSelectSession={selectReviewSession}
              onSelectLegacy={selectLegacy}
              files={sidebarFiles}
              allFiles={allFiles}
              viewed={viewed}
              threadCounts={threadCounts}
              activeFile={activeFile}
              onSelectFile={selectFile}
              onShowDiff={backToDiff}
              onCollapse={toggleSidebar}
            />
            <div
              className="sidebar-resizer"
              onMouseDown={startSidebarResize}
              title="Drag to resize"
            />
          </>
        )}
        <main className="layout" style={{ gridTemplateColumns: paneColumns }}>
        {/* N≥2: one module per repo, stacked inside a shared scroll container that
            owns the scroll-spy ref. N=1: the literal single diff pane, with the
            pane ref handed straight to it. Each ModuleSection provides its own
            snapshot context, so the diff side always sees its own repo's snapshot. */}
        {stacked ? (
          <section className="modmain" ref={diffPaneRef}>
            {visibleRepos.map((r, i) => {
              const moduleWorktree = selections.get(r.name)?.worktree ?? null;
              const worktreeSummary = selectedWorktreeSummary(r, moduleWorktree);
              return (
                <ModuleSection
                  key={r.name}
                  stacked
                  band={i % 2 === 0 ? 1 : 2}
                  focused={r.name === repo}
                  repo={r.name}
                  worktree={moduleWorktree}
                  branch={worktreeSummary?.branch ?? null}
                  pullRequest={worktreeSummary?.pullRequest ?? null}
                  diff={diffs.get(r.name) ?? null}
                  threads={scopedThreadsByRepo.get(r.name) ?? EMPTY_THREADS}
                  viewed={(viewedByRepo.get(r.name) ?? EMPTY_VIEWED) as Set<string>}
                  split={splitView}
                  wrap={wrapLines}
                  theme={theme}
                  target={selections.get(r.name)?.target ?? DEFAULT_TARGET}
                  refs={refsByRepo.get(r.name) ?? null}
                  defaultBranch={r.defaultBranch}
                  onTarget={changeTargetFor}
                  lifecycle={lifecycleByRepo.get(r.name)?.state ?? "idle"}
                  lifecycleSession={lifecycleByRepo.get(r.name)?.session ?? null}
                  onArchive={setArchivedFor}
                  collapsed={collapsedRepos.has(r.name)}
                  onToggleCollapse={toggleCollapseFor}
                  onToggleViewed={toggleViewedFor}
                  previewFile={r.name === repo ? previewFile : null}
                  onBackToDiff={backToDiff}
                  onChanged={refreshThreads}
                />
              );
            })}
          </section>
        ) : (
          <ModuleSection
            paneRef={diffPaneRef}
            repo={repo}
            worktree={worktree}
            branch={activeWorktree?.branch ?? null}
            pullRequest={activeWorktree?.pullRequest ?? null}
            diff={diff}
            threads={scopedThreads}
            viewed={viewed}
            split={splitView}
            wrap={wrapLines}
            theme={theme}
            target={target}
            refs={refs}
            defaultBranch={activeRepo?.defaultBranch ?? null}
            onTarget={changeTargetFor}
            lifecycle={lifecycleByRepo.get(repo)?.state ?? "idle"}
            lifecycleSession={lifecycleByRepo.get(repo)?.session ?? null}
            onArchive={setArchivedFor}
            onToggleViewed={toggleViewedFor}
            previewFile={previewFile}
            onBackToDiff={backToDiff}
            onChanged={refreshThreads}
          />
        )}
        {paneCollapsed ? (
          <button
            type="button"
            className="thread-reopen"
            onClick={toggleCollapsed}
            title="Show threads sidebar"
            aria-label="Show threads sidebar"
          >
            <Icon name="sidebar-collapse" size={15} />
          </button>
        ) : (
          <>
            <div
              className="pane-resizer"
              onMouseDown={startResize}
              title="Drag to resize"
            />
            {/* The thread pane carries its own snapshot context: the active diff's at
                N=1 (byte-identical to before), null at N≥2 — the aggregated inbox spans
                repos, so there's no single snapshot to mark "earlier iteration" against. */}
            <CurrentSnapshotContext.Provider
              value={stacked ? null : (diff?.currentSnapshotId ?? null)}
            >
              <aside className="thread-pane">
                <div className="thread-pane-head">
                  <span className="thread-pane-title">Threads</span>
                  <button
                    type="button"
                    className="thread-pane-toggle"
                    onClick={toggleCollapsed}
                    title="Hide threads sidebar"
                    aria-label="Hide threads sidebar"
                  >
                    <Icon name="sidebar-expand" size={14} />
                  </button>
                </div>
                <div className="thread-pane-body">
                  <div className="thread-pane-actions">
                    <button type="button" className="ghost" onClick={openSpaceComment}>
                      Comment on space
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => openRepoComment(repo)}
                    >
                      Comment on repo
                    </button>
                  </div>
                  {generalComment && (
                    <GeneralCommentForm
                      repo={generalComment.repo}
                      spacePath={generalComment.spacePath}
                      worktree={generalComment.worktree}
                      target={generalComment.target}
                      targetLevel={generalComment.targetLevel}
                      label={generalComment.label}
                      onCancel={closeGeneralComment}
                      onCreated={generalCommentCreated}
                    />
                  )}
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
                  {/* The "looks complete" banner is the N=1 chrome for completion. In the
                      modules view each module's status crumb owns Mark complete/Revive, so
                      the global banner (which can only speak for the active repo) yields to
                      the per-module crumbs to avoid a duplicate, repo-ambiguous affordance. */}
                  {!stacked && sessionDone && completableSession && (
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
                    showRepo={stacked}
                    onChanged={refreshThreads}
                    onNavigate={navigateToThread}
                  />
                </div>
              </aside>
            </CurrentSnapshotContext.Provider>
          </>
        )}
        </main>
      </div>
    </div>
  );
}
