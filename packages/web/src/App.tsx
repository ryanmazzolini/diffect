import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DAEMON_EVENTS } from "@diffect/shared";
import type {
  DiffChangedPayload,
  DiffFile,
  RefList,
  RepoDiff,
  ReviewTargetPresentation,
  RepoSummary,
  Thread,
  ThreadStatus,
  UiReviewSelection,
  WorkspaceEntry,
  WorkspaceInfo,
  WorktreeSummary,
} from "@diffect/shared";
import { api } from "./api.js";
import { Icon } from "./icons.js";
import { getStoredTheme, setTheme, type Theme } from "./theme.js";
import { getStoredDensity, setDensity, type Density } from "./density.js";
import {
  editorLabel,
  loadPreferredEditor,
  pickEditor,
  savePreferredEditor,
} from "./editorPreference.js";
import { getSessionStored, getStored, setSessionStored, setStored } from "./storage.js";
import { hasWorkingTreeSide } from "./reviewTarget.js";
import { fileElementId, orderedDiffFiles } from "./fileTree.js";
import { CurrentSnapshotContext } from "./currentSnapshot.js";
import { usePaneLayout } from "./usePaneLayout.js";
import { useResizable } from "./useResizable.js";
import { ModuleSection } from "./components/ModuleSection.js";
import { ThreadList } from "./components/ThreadList.js";
import {
  loadWorkspaceRecency,
  Topbar,
  WORKSPACE_RECENCY_KEY,
  WorkspaceRail,
} from "./components/Topbar.js";
import { Sidebar } from "./components/Sidebar.js";
import { SpaceFilePreview } from "./components/SpaceFilePreview.js";
import { AddWorkspaceDialog } from "./components/AddWorkspaceDialog.js";
import { GeneralCommentForm } from "./components/GeneralCommentForm.js";
import { PrDraftPanel } from "./components/PrDraftPanel.js";
import { StatusBar } from "./components/StatusBar.js";
import { WebsiteReviewLauncher } from "./components/WebsiteReviewLauncher.js";
import { isDesktopShell } from "./tauri.js";

type StatusFilter = ThreadStatus | "all";
type MainPaneTab = "diff" | "web" | "pr-draft";
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
// A repo's default review selection on first visit: its primary checkout, work target.
const DEFAULT_TARGET = "work";
const FOLLOW_MODE_KEY = "diffect-follow-mode";

function reconcileRepoDiff(previous: RepoDiff | undefined, next: RepoDiff): RepoDiff {
  if (!previous) return next;
  if (JSON.stringify(previous) === JSON.stringify(next)) return previous;

  const previousFiles = new Map(previous.files.map((file) => [file.path, file]));
  const files = next.files.map((file) => {
    const existing = previousFiles.get(file.path);
    return existing && JSON.stringify(existing) === JSON.stringify(file) ? existing : file;
  });
  return { ...next, files };
}

interface StoredSelection {
  worktree: string | null;
  target: string;
  presentation?: ReviewTargetPresentation;
}
type PendingFollow = DiffChangedPayload & {
  repo: string;
  path: string;
  minRefreshSeq: number;
};
interface ReadyFollow {
  request: PendingFollow;
  diff: RepoDiff;
}
interface DeepLinkSelection extends StoredSelection {
  workspacePath: string | null;
  repo: string | null;
}
interface StoredPlace extends StoredSelection {
  workspacePath: string | null;
  repo: string | null;
  file: string | null;
  selections: Record<string, StoredSelection>;
}
function cleanQueryValue(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
function readInitialDeepLink(): DeepLinkSelection {
  if (typeof window === "undefined") {
    return { workspacePath: null, repo: null, worktree: null, target: DEFAULT_TARGET };
  }
  const q = new URLSearchParams(window.location.search);
  return {
    workspacePath: cleanQueryValue(q.get("workspace")),
    repo: cleanQueryValue(q.get("repo")),
    worktree: cleanQueryValue(q.get("worktree")),
    target: cleanQueryValue(q.get("target")) ?? DEFAULT_TARGET,
  };
}
function readFollowMode(): boolean {
  const stored = getStored(FOLLOW_MODE_KEY);
  if (stored === "1") return true;
  if (stored === "0") return false;
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("shell") === "desktop";
}
function isFollowableTarget(target: string): boolean {
  return hasWorkingTreeSide(target);
}
const PLACE_KEY = "diffect-place-v1";
const WORKSPACE_PLACES_KEY = "diffect-workspace-places-v1";
const EMPTY_PLACE: StoredPlace = {
  workspacePath: null,
  repo: null,
  worktree: null,
  target: DEFAULT_TARGET,
  file: null,
  selections: {},
};
function parsePresentation(value: unknown): ReviewTargetPresentation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw.kind === "compare" &&
    typeof raw.baseRef === "string" &&
    typeof raw.baseLabel === "string" &&
    typeof raw.compareRef === "string" &&
    typeof raw.compareLabel === "string"
  ) {
    return {
      kind: "compare",
      baseRef: raw.baseRef,
      baseLabel: raw.baseLabel,
      ...(raw.baseIsRepoStart === true ? { baseIsRepoStart: true } : {}),
      compareRef: raw.compareRef,
      compareLabel: raw.compareLabel,
    };
  }
  return undefined;
}
function parseSelection(value: unknown): StoredSelection | null {
  if (!value || typeof value !== "object") return null;
  const sel = value as Partial<Record<keyof StoredSelection, unknown>>;
  const presentation = parsePresentation(sel.presentation);
  return {
    worktree: typeof sel.worktree === "string" ? sel.worktree : null,
    target: typeof sel.target === "string" ? sel.target : DEFAULT_TARGET,
    ...(presentation ? { presentation } : {}),
  };
}
function parseStoredPlace(value: unknown): StoredPlace {
  if (!value || typeof value !== "object") return EMPTY_PLACE;
  const place = value as Partial<Record<keyof StoredPlace, unknown>>;
  const presentation = parsePresentation(place.presentation);
  const selections: Record<string, StoredSelection> = {};
  if (place.selections && typeof place.selections === "object") {
    for (const [name, sel] of Object.entries(place.selections)) {
      const parsed = parseSelection(sel);
      if (parsed) selections[name] = parsed;
    }
  }
  return {
    workspacePath: typeof place.workspacePath === "string" ? place.workspacePath : null,
    repo: typeof place.repo === "string" ? place.repo : null,
    worktree: typeof place.worktree === "string" ? place.worktree : null,
    target: typeof place.target === "string" ? place.target : DEFAULT_TARGET,
    ...(presentation ? { presentation } : {}),
    file: typeof place.file === "string" ? place.file : null,
    selections,
  };
}
function readStoredPlace(): StoredPlace {
  try {
    return parseStoredPlace(JSON.parse(getSessionStored(PLACE_KEY) ?? "{}"));
  } catch {
    return EMPTY_PLACE;
  }
}
function readWorkspacePlaces(): Record<string, StoredPlace> {
  try {
    const parsed = JSON.parse(getSessionStored(WORKSPACE_PLACES_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, StoredPlace> = {};
    for (const [path, value] of Object.entries(parsed)) out[path] = parseStoredPlace(value);
    return out;
  } catch {
    return {};
  }
}
function readWorkspacePlace(path: string): StoredPlace | null {
  return readWorkspacePlaces()[path] ?? null;
}
function mostRecentStoredWorkspacePath(
  recency = loadWorkspaceRecency(),
  paths?: Set<string>,
): string | null {
  let best: string | null = null;
  let bestTs = 0;
  for (const [path, ts] of Object.entries(recency)) {
    if (paths && !paths.has(path)) continue;
    if (ts > bestTs) {
      best = path;
      bestTs = ts;
    }
  }
  return best;
}
function mostRecentWorkspacePath(
  entries: WorkspaceEntry[],
  recency: Record<string, number>,
): string | null {
  return mostRecentStoredWorkspacePath(recency, new Set(entries.map((entry) => entry.path)));
}
function latestReviewRepo(
  entry: WorkspaceEntry,
  reviewRecency: Record<string, Record<string, UiReviewSelection>>,
): string | null {
  const allowed = new Set(entry.repos.map((r) => r.name));
  let best: string | null = null;
  let bestTs = -1;
  for (const [repo, review] of Object.entries(reviewRecency[entry.path] ?? {})) {
    if (allowed.has(repo) && review.openedAt > bestTs) {
      best = repo;
      bestTs = review.openedAt;
    }
  }
  return best;
}
function recentSelectionsFor(
  entry: WorkspaceEntry,
  reviewRecency: Record<string, Record<string, UiReviewSelection>>,
): Record<string, StoredSelection> {
  const allowed = new Set(entry.repos.map((r) => r.name));
  const out: Record<string, StoredSelection> = {};
  for (const [repo, review] of Object.entries(reviewRecency[entry.path] ?? {})) {
    if (allowed.has(repo)) {
      out[repo] = {
        worktree: review.worktree,
        target: review.target,
        ...(review.presentation ? { presentation: review.presentation } : {}),
      };
    }
  }
  return out;
}
// The session-count map key standing in for legacy (pre-scope, sessionId === null)
// threads, which share the dedicated unscoped bucket rather than any one session.
const LEGACY_KEY = "__legacy__";
// Signature of a (worktree, target) selection — the cache key the diff fan-out
// dedupes on, so scroll-focus promoting a repo to active doesn't refetch a module
// whose selection is already loaded.
const selSig = (worktree: string | null, target: string) =>
  `${worktree ?? ""}::${target}`;
const FIRST_DIFF_CHANGE_SELECTOR = [
  ".cm-insertedLine",
  ".cm-changedLine",
  ".cm-inlineChangedLine",
  ".cm-deletedChunk",
  ".cm-deletedLine",
].join(", ");
// CSS.escape guard for the rare attribute selector (a repo name with a quote or
// backslash); falls back to the raw string where CSS.escape is unavailable.
function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s;
}
function scrollFileIntoView(
  repo: string,
  path: string,
  focusFirstChange = false,
  stillCurrent: () => boolean = () => true,
): void {
  if (!stillCurrent()) return;
  const file = document.getElementById(fileElementId(repo, path));
  file?.scrollIntoView({ block: "start" });
  if (!focusFirstChange) return;

  let attempts = 0;
  const focusChange = () => {
    if (!stillCurrent()) return;
    const currentFile = document.getElementById(fileElementId(repo, path));
    const firstChange = currentFile?.querySelector<HTMLElement>(FIRST_DIFF_CHANGE_SELECTOR);
    if (firstChange) {
      firstChange.scrollIntoView({ block: "center" });
      return;
    }
    // Follow can select a file before scroll-windowing, file content fetch, and
    // lazy CodeMirror mount have all settled. Retry briefly so the landing point
    // is the first hunk, not only the file header.
    if (attempts++ < 12) window.setTimeout(focusChange, 75);
  };
  window.requestAnimationFrame(focusChange);
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
type RefThreadCount = { open: number; total: number };
const EMPTY_REF_THREAD_COUNTS: ReadonlyMap<string, RefThreadCount> = new Map();

function WorkspaceSkeleton() {
  return (
    <div className="workspace-skeleton" aria-label="Loading workspace" aria-busy="true">
      <div className="sk-topbar">
        <div className="sk-brand sk-block" />
        <div className="sk-title sk-block" />
        <div className="sk-path sk-block" />
        <div className="sk-spacer" />
        <div className="sk-pill sk-block" />
        <div className="sk-pill sk-block" />
        <div className="sk-icon sk-block" />
      </div>
      <div className="sk-workbench">
        <aside className="sk-sidebar" aria-hidden="true">
          <div className="sk-panel-title sk-block" />
          {Array.from({ length: 8 }, (_, index) => (
            <div className="sk-tree-row" key={index}>
              <div className="sk-dot sk-block" />
              <div className={`sk-tree-line sk-block w${(index % 4) + 1}`} />
            </div>
          ))}
        </aside>
        <main className="sk-main" aria-hidden="true">
          <div className="sk-tabs">
            <div className="sk-tab sk-block" />
            <div className="sk-tab short sk-block" />
          </div>
          <section className="sk-module">
            <div className="sk-module-head">
              <div className="sk-module-title sk-block" />
              <div className="sk-module-stat sk-block" />
            </div>
            {Array.from({ length: 3 }, (_, fileIndex) => (
              <div className="sk-file" key={fileIndex}>
                <div className="sk-file-head">
                  <div className="sk-file-name sk-block" />
                  <div className="sk-file-stat sk-block" />
                </div>
                {Array.from({ length: 5 }, (_, lineIndex) => (
                  <div className="sk-code-row" key={lineIndex}>
                    <div className="sk-line-no sk-block" />
                    <div className={`sk-code-line sk-block w${((fileIndex + lineIndex) % 4) + 1}`} />
                  </div>
                ))}
              </div>
            ))}
          </section>
        </main>
        <aside className="sk-threads" aria-hidden="true">
          <div className="sk-panel-title sk-block" />
          {Array.from({ length: 3 }, (_, index) => (
            <div className="sk-thread" key={index}>
              <div className="sk-thread-line sk-block" />
              <div className="sk-thread-line short sk-block" />
              <div className="sk-thread-body sk-block" />
            </div>
          ))}
        </aside>
      </div>
      <div className="sk-statusbar">
        <div className="sk-status sk-block" />
        <div className="sk-status short sk-block" />
      </div>
      <span className="sr-only">Loading workspace…</span>
    </div>
  );
}

export function App() {
  const [initialDeepLink] = useState(readInitialDeepLink);
  const [initialPlace] = useState(readStoredPlace);
  const initialRepo = initialDeepLink.repo ?? initialPlace.repo;
  const initialWorkspacePath =
    initialDeepLink.workspacePath ?? mostRecentStoredWorkspacePath() ?? initialPlace.workspacePath;
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [repo, setRepo] = useState<string | null>(initialRepo);
  const [activeWorkspacePath, setActiveWorkspacePath] = useState<string | null>(
    initialWorkspacePath,
  );
  // Per-repo review selection (checkout + target + optional display metadata),
  // so each stacked module keeps its own review task independently. The active
  // repo's entry is projected to
  // the `worktree`/`target` scalars below, which the rest of the component reads
  // unchanged. A repo absent from the map renders its first-visit default
  // (primary checkout, work target) via that projection.
  const [selections, setSelections] = useState<Map<string, StoredSelection>>(() => {
    const m = new Map<string, StoredSelection>();
    for (const [name, sel] of Object.entries(initialPlace.selections)) m.set(name, sel);
    if (initialRepo) {
      m.set(initialRepo, {
        worktree: initialDeepLink.repo ? initialDeepLink.worktree : initialPlace.worktree,
        target: initialDeepLink.repo ? initialDeepLink.target : initialPlace.target,
        ...(!initialDeepLink.repo && initialPlace.presentation
          ? { presentation: initialPlace.presentation }
          : {}),
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
  const [allFilesByRepo, setAllFilesByRepo] = useState<Map<string, string[]>>(
    () => new Map(),
  );
  const [ignoredFilesByRepo, setIgnoredFilesByRepo] = useState<Map<string, string[]>>(
    () => new Map(),
  );
  const [spaceFiles, setSpaceFiles] = useState<string[]>([]);
  const [sidebarFileMode, setSidebarFileMode] = useState<"diff" | "all">("diff");
  const [showIgnoredFiles, setShowIgnoredFiles] = useState(false);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [filter, setFilter] = useState<StatusFilter>("open");
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);
  const [density, setDensityState] = useState<Density>(getStoredDensity);
  const [preferredEditor, setPreferredEditorState] = useState(loadPreferredEditor);
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [workspaceRecency, setWorkspaceRecency] = useState(loadWorkspaceRecency);
  const [reviewRecency, setReviewRecency] = useState<
    Record<string, Record<string, UiReviewSelection>>
  >({});
  const [workspacePlaces, setWorkspacePlaces] = useState(readWorkspacePlaces);
  const [uiStateLoaded, setUiStateLoaded] = useState(false);
  const [activeFile, setActiveFile] = useState<string | null>(initialPlace.file);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [spacePreviewFile, setSpacePreviewFile] = useState<string | null>(null);
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
  const [followMode, setFollowMode] = useState(readFollowMode);
  const toggleFollowMode = useCallback(() => {
    setFollowMode((enabled) => {
      setStored(FOLLOW_MODE_KEY, enabled ? "0" : "1");
      return !enabled;
    });
  }, []);
  const [addOpen, setAddOpen] = useState(false);
  const [generalComment, setGeneralComment] = useState<GeneralCommentTarget | null>(null);
  const [mainTab, setMainTab] = useState<MainPaneTab>("diff");
  const [prDraftReloadKey, setPrDraftReloadKey] = useState(0);
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
  // Invalidates delayed first-hunk scroll attempts when a newer follow event or
  // manual file selection wins. Without this token, an older retry can yank the
  // viewport back to the previous file after the user has moved on.
  const fileScrollGenerationRef = useRef(0);
  const programmaticRepoRef = useRef<string | null>(null);
  const programmaticRepoTimerRef = useRef<number | null>(null);
  const programmaticFileRef = useRef<string | null>(null);
  const programmaticFileTimerRef = useRef<number | null>(null);
  const followModeRef = useRef(followMode);
  followModeRef.current = followMode;
  const pendingFollowRef = useRef<PendingFollow | null>(null);
  const [readyFollow, setReadyFollow] = useState<ReadyFollow | null>(null);

  // Active-repo projection of the per-repo maps. Every reader below (memos,
  // effects, render, child props) uses these scalars exactly as before the lift,
  // so the single-repo path is the literal N=1 case of the per-repo collections.
  const selection = repo ? selections.get(repo) : undefined;
  const worktree = selection?.worktree ?? null;
  const target = selection?.target ?? DEFAULT_TARGET;
  const diff = (repo ? diffs.get(repo) : undefined) ?? null;
  const refs = (repo ? refsByRepo.get(repo) : undefined) ?? null;
  const showUnscoped = repo ? (showUnscopedByRepo.get(repo) ?? false) : false;
  const pendingSession = repo ? (pendingByRepo.get(repo) ?? null) : null;
  const threadSession = repo ? (threadSessionByRepo.get(repo) ?? null) : null;

  // Latest workspace/selections for callbacks that must read current state without
  // subscribing to it (the SSE fan-out, the per-repo refreshers). A ref keeps
  // those callbacks stable so they neither tear down the EventSource nor defeat
  // the module memo on every selection change.
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const activeWorkspacePathRef = useRef(activeWorkspacePath);
  activeWorkspacePathRef.current = activeWorkspacePath;
  const selectionsRef = useRef(selections);
  selectionsRef.current = selections;
  const activeEntry = useMemo(
    () =>
      entries.find((ws) => ws.path === activeWorkspacePath) ??
      entries.find((ws) => ws.repos.some((r) => r.name === repo)) ??
      null,
    [activeWorkspacePath, entries, repo],
  );
  const visibleRepos = activeEntry?.repos ?? (activeWorkspacePath ? [] : workspace?.repos ?? []);
  const followAvailable = visibleRepos.some((visibleRepo) =>
    isFollowableTarget(selections.get(visibleRepo.name)?.target ?? DEFAULT_TARGET),
  );
  const visibleWorkspace = useMemo<WorkspaceInfo | null>(
    () =>
      workspace
        ? {
            ...workspace,
            root: activeEntry?.path ?? activeWorkspacePath ?? workspace.root,
            repos: visibleRepos,
          }
        : null,
    [activeEntry?.path, activeWorkspacePath, visibleRepos, workspace],
  );
  const activeSpacePath = visibleWorkspace?.root ?? null;
  const prDraftTargets = useMemo(
    () => visibleRepos.map((r) => ({ repo: r.name, worktree: selections.get(r.name)?.worktree ?? null })),
    [selections, visibleRepos],
  );
  // N≥2 ⇒ the stacked "modules view" (one diff list per repo, sharing a scroll
  // container); N≤1 ⇒ the literal single pane. A presentational switch only: every
  // selector/effect below still treats the single repo as the N=1 case.
  const stacked = visibleRepos.length > 1;
  // Stable key over the repo *names* so the module scroll-spy re-subscribes when the
  // set of repos changes, but not when a diff/selection inside one does.
  const repoNamesKey = JSON.stringify(visibleRepos.map((r) => r.name));

  const persistPlace = useCallback(
    (
      file: string | null,
      placeRepo = repo,
      placeWorktree = worktree,
      placeTarget = target,
      placePresentation = placeRepo ? selections.get(placeRepo)?.presentation : undefined,
    ) => {
      if (!activeWorkspacePath || !activeEntry || activeEntry.path !== activeWorkspacePath) return;
      const workspacePath = activeEntry.path;
      if (!workspacePath && !placeRepo && !file) return;
      const storedSelections = Object.fromEntries(
        visibleRepos.map((r) => {
          const sel = selections.get(r.name) ?? { worktree: null, target: DEFAULT_TARGET };
          return [r.name, sel];
        }),
      );
      const place: StoredPlace = {
        workspacePath,
        repo: placeRepo,
        worktree: placeWorktree,
        target: placeTarget,
        ...(placePresentation ? { presentation: placePresentation } : {}),
        file,
        selections: storedSelections,
      };
      setSessionStored(PLACE_KEY, JSON.stringify(place));
      if (workspacePath) {
        setWorkspacePlaces((prev) => {
          const next = { ...prev, [workspacePath]: place };
          setSessionStored(WORKSPACE_PLACES_KEY, JSON.stringify(next));
          return next;
        });
      }
    },
    [
      activeEntry,
      activeWorkspacePath,
      repo,
      selections,
      target,
      visibleRepos,
      worktree,
    ],
  );

  useEffect(() => {
    if (spacePreviewFile) persistPlace(activeFile, null, null, DEFAULT_TARGET);
    else persistPlace(activeFile);
  }, [activeFile, persistPlace, spacePreviewFile]);

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
  const markWorkspaceOpened = useCallback((path: string) => {
    const ts = Date.now();
    setWorkspaceRecency((prev) => {
      const next = { ...prev, [path]: ts };
      setStored(WORKSPACE_RECENCY_KEY, JSON.stringify(next));
      return next;
    });
    void api.updateUiState({ workspaceRecency: { [path]: ts } }).catch(() => {});
  }, []);
  const markReviewOpened = useCallback(
    (forRepo: string, sel: StoredSelection) => {
      if (!activeEntry || activeEntry.path !== activeWorkspacePath) return;
      const opened: UiReviewSelection = { ...sel, openedAt: Date.now() };
      const workspacePath = activeEntry.path;
      setReviewRecency((prev) => ({
        ...prev,
        [workspacePath]: { ...(prev[workspacePath] ?? {}), [forRepo]: opened },
      }));
      void api
        .updateUiState({ reviewRecency: { [workspacePath]: { [forRepo]: opened } } })
        .catch(() => {});
    },
    [activeEntry, activeWorkspacePath],
  );

  const loadWorkspaces = useCallback(() => {
    api.workspaces().then(setEntries).catch(() => setEntries([]));
  }, []);

  useEffect(() => {
    if (uiStateLoaded && activeEntry?.path && activeEntry.path === activeWorkspacePath) {
      markWorkspaceOpened(activeEntry.path);
    }
  }, [activeEntry?.path, activeWorkspacePath, markWorkspaceOpened, uiStateLoaded]);

  const lockProgrammaticFile = useCallback((path: string) => {
    programmaticFileRef.current = path;
    if (programmaticFileTimerRef.current !== null) {
      window.clearTimeout(programmaticFileTimerRef.current);
      programmaticFileTimerRef.current = null;
    }
  }, []);

  const selectFile = useCallback(
    (path: string) => {
      fileScrollGenerationRef.current += 1;
      const match = diff?.files.find((f) => f.path === path || f.oldPath === path);
      const scrollPath = match?.path ?? path;
      lockProgrammaticFile(scrollPath);
      setActiveFile(scrollPath);
      persistPlace(scrollPath);
      if (match && repo) {
        setPreviewFile(null);
        setSpacePreviewFile(null);
        scrollFileIntoView(repo, scrollPath);
      } else {
        setSpacePreviewFile(null);
        setPreviewFile(path);
        diffPaneRef.current?.scrollTo({ top: 0 });
      }
    },
    [diff, lockProgrammaticFile, persistPlace, repo],
  );

  const selectTreeFile = useCallback(
    (fileRepo: string | null, path: string, options: { focusFirstChange?: boolean } = {}) => {
      const scrollGeneration = ++fileScrollGenerationRef.current;
      if (fileRepo === null) {
        setSpacePreviewFile(path);
        setPreviewFile(null);
        setActiveFile(path);
        persistPlace(path, null, null, DEFAULT_TARGET);
        diffPaneRef.current?.scrollTo({ top: 0 });
        return;
      }

      const fileDiff = diffs.get(fileRepo) ?? (fileRepo === repo ? diff : null);
      const match = fileDiff?.files.find((f) => f.path === path || f.oldPath === path);
      const scrollPath = match?.path ?? path;
      const sel = selectionsRef.current.get(fileRepo) ?? { worktree: null, target: DEFAULT_TARGET };
      setRepo(fileRepo);
      lockProgrammaticFile(scrollPath);
      setActiveFile(scrollPath);
      persistPlace(scrollPath, fileRepo, sel.worktree, sel.target, sel.presentation);
      setSpacePreviewFile(null);
      if (match) {
        setPreviewFile(null);
        requestAnimationFrame(() =>
          scrollFileIntoView(
            fileRepo,
            scrollPath,
            options.focusFirstChange,
            () => fileScrollGenerationRef.current === scrollGeneration,
          ),
        );
      } else {
        setPreviewFile(path);
        diffPaneRef.current?.scrollTo({ top: 0 });
      }
    },
    [diff, diffs, lockProgrammaticFile, persistPlace, repo],
  );

  useEffect(() => {
    if (!readyFollow) return;
    setReadyFollow(null);
    const { request, diff: refreshedDiff } = readyFollow;
    if (!followModeRef.current || !visibleRepos.some((r) => r.name === request.repo)) return;
    const sel = selections.get(request.repo) ?? { worktree: null, target: DEFAULT_TARGET };
    if ((request.worktree ?? null) !== sel.worktree || !isFollowableTarget(sel.target)) return;
    const match = refreshedDiff.files.find(
      (f) => f.path === request.path || f.oldPath === request.path,
    );
    if (!match) return;
    setMainTab("diff");
    selectTreeFile(request.repo, match.path, { focusFirstChange: true });
    setLive(`Following ${match.path}`);
  }, [readyFollow, selections, selectTreeFile, visibleRepos]);

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
      if (thread.repo === null) {
        selectTreeFile(null, thread.file);
        return;
      }
      const threadRepo = thread.repo ?? repo;
      if (!threadRepo) return;
      const threadDiff = diffs.get(threadRepo) ?? (threadRepo === repo ? diff : null);
      const match = threadDiff?.files.find(
        (f) => f.path === thread.file || f.oldPath === thread.file,
      );
      const scrollPath = match?.path ?? thread.file;

      const sel = selectionsRef.current.get(threadRepo) ?? { worktree: null, target: DEFAULT_TARGET };
      setRepo(threadRepo);
      lockProgrammaticFile(scrollPath);
      setActiveFile(scrollPath);
      persistPlace(scrollPath, threadRepo, sel.worktree, sel.target, sel.presentation);
      setSpacePreviewFile(null);
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
    [diff, diffs, lockProgrammaticFile, persistPlace, repo, scrollThreadIntoView, selectTreeFile],
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
    setSpacePreviewFile(null);
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
      const entry = entries.find((ws) => ws.path === path);
      const allowed = new Set(entry?.repos.map((r) => r.name) ?? []);
      const place = workspacePlaces[path] ?? readWorkspacePlace(path);
      const recentSelections = entry ? recentSelectionsFor(entry, reviewRecency) : {};
      setActiveWorkspacePath(path);
      const selectionsToRestore = place?.selections ?? recentSelections;
      if (selectionsToRestore) {
        setSelections((prev) => {
          const next = new Map(prev);
          for (const [name, sel] of Object.entries(selectionsToRestore)) {
            if (allowed.has(name)) next.set(name, sel);
          }
          return next;
        });
      }
      const storedRepo = place?.repo && allowed.has(place.repo) ? place.repo : null;
      const recentRepo = entry ? latestReviewRepo(entry, reviewRecency) : null;
      const nextRepo = storedRepo ?? recentRepo ?? entry?.repos[0]?.name ?? null;
      if (nextRepo) selectRepo(nextRepo);
      else setRepo(null);
      setActiveFile(place?.file ?? null);
      setSpacePreviewFile(place?.repo === null ? (place.file ?? null) : null);
      setPreviewFile(null);
    },
    [entries, reviewRecency, selectRepo, workspacePlaces],
  );

  const autoWorkspacePicked = useRef(false);
  useEffect(() => {
    if (
      autoWorkspacePicked.current ||
      !uiStateLoaded ||
      initialDeepLink.repo ||
      initialDeepLink.workspacePath ||
      entries.length === 0
    ) {
      return;
    }
    const recent = mostRecentWorkspacePath(entries, workspaceRecency);
    if (recent && recent !== activeWorkspacePath) {
      autoWorkspacePicked.current = true;
      selectWorkspace(recent);
    } else if (activeWorkspacePath && !entries.some((entry) => entry.path === activeWorkspacePath)) {
      autoWorkspacePicked.current = true;
      const fallback = entries[0]?.path ?? null;
      if (fallback) selectWorkspace(fallback);
      else setActiveWorkspacePath(null);
    }
  }, [activeWorkspacePath, entries, initialDeepLink.repo, initialDeepLink.workspacePath, selectWorkspace, uiStateLoaded, workspaceRecency]);

  const restoredWorkspacePlaces = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (
      !uiStateLoaded ||
      !activeEntry ||
      activeEntry.path !== activeWorkspacePath ||
      restoredWorkspacePlaces.current.has(activeEntry.path)
    ) {
      return;
    }
    const place = workspacePlaces[activeEntry.path] ?? readWorkspacePlace(activeEntry.path);
    const selectionsToRestore = place?.selections ?? recentSelectionsFor(activeEntry, reviewRecency);
    restoredWorkspacePlaces.current.add(activeEntry.path);
    const allowed = new Set(activeEntry.repos.map((r) => r.name));
    setSelections((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const [name, sel] of Object.entries(selectionsToRestore)) {
        if (!allowed.has(name)) continue;
        const cur = next.get(name);
        if (
          cur?.worktree === sel.worktree &&
          cur.target === sel.target &&
          JSON.stringify(cur.presentation) === JSON.stringify(sel.presentation)
        ) {
          continue;
        }
        next.set(name, sel);
        changed = true;
      }
      return changed ? next : prev;
    });
    const nextRepo =
      place?.repo && allowed.has(place.repo) ? place.repo : latestReviewRepo(activeEntry, reviewRecency);
    if (!initialDeepLink.repo && nextRepo) setRepo(nextRepo);
    if (place?.repo === null && place.file) {
      setActiveFile(place.file);
      setSpacePreviewFile(place.file);
      setPreviewFile(null);
    }
  }, [activeEntry, activeWorkspacePath, initialDeepLink.repo, reviewRecency, uiStateLoaded, workspacePlaces]);

  useEffect(() => {
    if (
      !activeEntry ||
      activeEntry.path !== activeWorkspacePath ||
      (repo && activeEntry.repos.some((r) => r.name === repo))
    ) {
      return;
    }
    const place = workspacePlaces[activeEntry.path] ?? readWorkspacePlace(activeEntry.path);
    const storedRepo = place?.repo && activeEntry.repos.some((r) => r.name === place.repo) ? place.repo : null;
    const recentRepo = latestReviewRepo(activeEntry, reviewRecency);
    const firstRepo = storedRepo ?? recentRepo ?? activeEntry.repos[0]?.name;
    if (firstRepo) setRepo(firstRepo);
  }, [activeEntry, activeWorkspacePath, repo, reviewRecency, workspacePlaces]);
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
  const collapseAllModules = useCallback(() => {
    setCollapsedRepos(new Set(visibleRepos.map((r) => r.name)));
  }, [visibleRepos]);
  const expandAllModules = useCallback(() => setCollapsedRepos(new Set()), []);

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
          includeIgnored: showIgnoredFiles,
        });
        if (seq === diffSeqs.current.get(forRepo)) {
          setDiffs((prev) => {
            const reconciled = reconcileRepoDiff(prev.get(forRepo), next);
            return reconciled === prev.get(forRepo)
              ? prev
              : new Map(prev).set(forRepo, reconciled);
          });
          setError(null);
          const pendingFollow = pendingFollowRef.current;
          if (
            pendingFollow?.repo === forRepo &&
            seq >= pendingFollow.minRefreshSeq
          ) {
            pendingFollowRef.current = null;
            setReadyFollow({ request: pendingFollow, diff: next });
          }
          loadedSelRef.current.set(
            forRepo,
            `${selSig(sel.worktree, sel.target)}::ignored=${showIgnoredFiles ? "1" : "0"}`,
          );
          setPendingFor(forRepo, null);
        }
      } catch (e) {
        if (seq === diffSeqs.current.get(forRepo)) {
          setError(String(e));
          // Settled with an error (deleted base ref → 500, removed worktree → 404).
          // Retire the optimistic highlight so it can't pin the sidebar/filter to a
          // session whose diff never loads; leave loadedSelRef unset so a re-click
          // (reselectTick) retries instead of being skipped as already-loaded.
          const pendingFollow = pendingFollowRef.current;
          if (pendingFollow?.repo === forRepo && seq >= pendingFollow.minRefreshSeq) {
            pendingFollowRef.current = null;
          }
          setPendingFor(forRepo, null);
        }
      }
    },
    [setPendingFor, showIgnoredFiles],
  );
  // Refresh only the repo/worktree invalidated by a filesystem event. Older or
  // deliberately unscoped events still fall back to all visible repos. Follow
  // uses the same payload as a navigation hint after this source-of-truth reload.
  const refreshDiffsForEvent = useCallback((payload: DiffChangedPayload) => {
    const repos = workspaceRef.current?.repos ?? [];
    const affected = payload.repo
      ? repos.filter((candidate) => candidate.name === payload.repo)
      : repos;
    for (const candidate of affected) {
      const sel = selectionsRef.current.get(candidate.name) ?? {
        worktree: null,
        target: DEFAULT_TARGET,
      };
      if ("worktree" in payload && (payload.worktree ?? null) !== sel.worktree) continue;
      void refreshDiffFor(candidate.name, sel);
    }
  }, [refreshDiffFor]);

  const workspaceSeq = useRef(0);
  const refreshWorkspace = useCallback((workspacePath = activeWorkspacePathRef.current) => {
    const seq = ++workspaceSeq.current;
    api
      .workspace(workspacePath)
      .then((ws) => {
        if (seq !== workspaceSeq.current) return;
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
      .catch((e) => {
        if (seq === workspaceSeq.current) setError(String(e));
      });
  }, []);

  useEffect(() => {
    api
      .uiState()
      .then((state) => {
        setWorkspaceRecency(state.workspaceRecency);
        setReviewRecency(state.reviewRecency);
        setStored(WORKSPACE_RECENCY_KEY, JSON.stringify(state.workspaceRecency));
      })
      .catch(() => {})
      .finally(() => setUiStateLoaded(true));
  }, []);

  useEffect(() => {
    refreshWorkspace(activeWorkspacePath);
  }, [activeWorkspacePath, refreshWorkspace]);

  useEffect(() => {
    loadWorkspaces();
    refreshThreads();
  }, [loadWorkspaces, refreshThreads]);

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
    (forRepo: string, next: string, presentation?: ReviewTargetPresentation) => {
      setUnscopedFor(forRepo, false);
      setPendingFor(forRepo, null);
      setThreadSessionFor(forRepo, null);
      const sel: StoredSelection = {
        worktree: selectionsRef.current.get(forRepo)?.worktree ?? null,
        target: next,
        ...(presentation ? { presentation } : {}),
      };
      setSelections((prev) => new Map(prev).set(forRepo, sel));
      markReviewOpened(forRepo, sel);
    },
    [markReviewOpened, setUnscopedFor, setPendingFor, setThreadSessionFor],
  );
  const selectLegacy = useCallback(() => {
    if (!repo) return;
    setPendingFor(repo, null);
    setThreadSessionFor(repo, null);
    setUnscopedFor(repo, true);
  }, [repo, setPendingFor, setThreadSessionFor, setUnscopedFor]);

  useEffect(() => {
    setPreviewFile(null);
    setSpacePreviewFile(null);
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
  // Load compare refs only for the focused repo. Other modules can still search
  // server-side from their picker, and focusing a module preloads its ref summary.
  useEffect(() => {
    if (!workspace || !repo) return;
    const activeRepo = visibleRepos.find((r) => r.name === repo);
    if (!activeRepo) return;
    const wt = selections.get(activeRepo.name)?.worktree ?? null;
    if (loadedRefsRef.current.get(activeRepo.name) === (wt ?? "")) return;
    void refreshRefsFor(activeRepo.name, wt);
  }, [workspace, visibleRepos, repo, selections, refreshRefsFor]);

  // The tracked-file and space-file scans are only needed for the sidebar's All
  // files mode. Avoid running them on every workspace switch while the default
  // Changed files tree is showing.
  useEffect(() => {
    if (!workspace || sidebarFileMode !== "all") return;
    let live = true;
    Promise.all(
      visibleRepos.map(async (r) => {
        const wt = selections.get(r.name)?.worktree ?? null;
        try {
          const result = await api.repoFiles(r.name, wt, showIgnoredFiles);
          return [r.name, result.files, result.ignoredFiles ?? []] as const;
        } catch {
          return [r.name, [] as string[], [] as string[]] as const;
        }
      }),
    ).then((rows) => {
      if (!live) return;
      setAllFilesByRepo((prev) => {
        const next = new Map(prev);
        for (const [name, files] of rows) next.set(name, files);
        return next;
      });
      setIgnoredFilesByRepo((prev) => {
        const next = new Map(prev);
        for (const [name, , ignoredFiles] of rows) next.set(name, ignoredFiles);
        return next;
      });
    });
    return () => {
      live = false;
    };
  }, [workspace, visibleRepos, selections, sidebarFileMode, showIgnoredFiles]);

  useEffect(() => {
    if (!activeSpacePath || sidebarFileMode !== "all") return;
    let live = true;
    api
      .spaceFiles(activeSpacePath)
      .then((r) => live && setSpaceFiles(r.files))
      .catch(() => live && setSpaceFiles([]));
    return () => {
      live = false;
    };
  }, [activeSpacePath, sidebarFileMode]);

  // Load the focused repo's diff first, then hydrate sibling modules shortly
  // after. Workspace switching should show the selected repo promptly instead of
  // waiting behind every repo in a multi-repo space. Wait for persisted UI state
  // before the first load so a restored compare target does not briefly flash
  // the default work diff.
  useEffect(() => {
    if (!workspace || !uiStateLoaded) return;
    const forced = lastReselectRef.current !== reselectTick;
    lastReselectRef.current = reselectTick;
    const pending = visibleRepos.filter((r) => {
      const sel = selections.get(r.name) ?? {
        worktree: null,
        target: DEFAULT_TARGET,
      };
      const loaded =
        loadedSelRef.current.get(r.name) ===
        `${selSig(sel.worktree, sel.target)}::ignored=${showIgnoredFiles ? "1" : "0"}`;
      const isFocused = r.name === repo;
      return !loaded || (isFocused && forced);
    });
    const focused = pending.find((r) => r.name === repo);
    const refresh = (r: RepoSummary) => {
      const sel = selections.get(r.name) ?? {
        worktree: null,
        target: DEFAULT_TARGET,
      };
      void refreshDiffFor(r.name, sel);
    };
    if (focused) refresh(focused);
    const rest = pending.filter((r) => r.name !== repo);
    if (rest.length === 0) return;
    const timer = window.setTimeout(() => rest.forEach(refresh), 150);
    return () => window.clearTimeout(timer);
  }, [
    workspace,
    uiStateLoaded,
    visibleRepos,
    repo,
    selections,
    reselectTick,
    refreshDiffFor,
    showIgnoredFiles,
  ]);

  const sidebarFiles = useMemo(() => diff?.files ?? EMPTY_FILES, [diff]);
  const diffFilePathsKey = useMemo(
    () => sidebarFiles.map((file) => file.path).join("\0"),
    [sidebarFiles],
  );
  // Render the diff in the same order the sidebar tree shows, so the active-file
  // highlight walks the tree top-to-bottom as you scroll instead of jumping.
  const orderedFiles = useMemo(() => orderedDiffFiles(sidebarFiles), [sidebarFiles]);
  // Files backing the topbar's aggregate diffstat. At N≥2 it's every module's
  // files (the header summarizes the whole modules view); at N=1 it's the single
  // repo's — identical to `sidebarFiles`.
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

  useEffect(() => {
    const root = diffPaneRef.current;
    if (!root) return;
    const unlock = () => {
      programmaticFileRef.current = null;
    };
    root.addEventListener("wheel", unlock, { passive: true });
    root.addEventListener("touchstart", unlock, { passive: true });
    return () => {
      root.removeEventListener("wheel", unlock);
      root.removeEventListener("touchstart", unlock);
    };
  }, []);

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
      () => {
        const rootRect = root.getBoundingClientRect();
        const scanBottom = rootRect.top + rootRect.height * 0.3;
        const visible = headers
          .map((el) => ({ el, rect: el.getBoundingClientRect() }))
          .filter(({ rect }) => rect.bottom >= rootRect.top && rect.top <= scanBottom)
          .sort((a, b) => a.rect.top - b.rect.top);
        const locked = programmaticFileRef.current;
        if (locked) {
          setActiveFile(locked);
          return;
        }
        const path = visible[0]?.el.getAttribute("data-path");
        if (!path) return;
        setActiveFile(path);
      },
      { root, rootMargin: "0px 0px -70% 0px", threshold: 0 },
    );
    headers.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [diffFilePathsKey, repo, previewFile]);

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
      if (mainTab !== "diff") return;
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
  }, [orderedFiles, activeFile, mainTab, selectFile]);

  // Live updates: subscribe to the daemon's SSE stream exactly once and route
  // events to the *latest* refreshers via a ref. Re-subscribing whenever a
  // selector changed would tear the EventSource down and drop events that fire
  // during the reconnect gap.
  const refreshers = useRef({ refreshThreads, refreshDiffsForEvent, refreshWorkspace, loadWorkspaces });
  refreshers.current = { refreshThreads, refreshDiffsForEvent, refreshWorkspace, loadWorkspaces };
  // Filesystem events are already debounced by the daemon; coalesce once more
  // in the browser so repeated external saves produce one render per settled
  // repo/worktree rather than repainting on every intermediate write.
  const diffRefreshTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const queuedDiffPayloads = useRef<Map<string, DiffChangedPayload>>(new Map());
  const refreshDiffSoon = useCallback((payload: DiffChangedPayload) => {
    const timers = diffRefreshTimers.current;
    const queued = queuedDiffPayloads.current;
    const key = payload.repo ?? "*";

    if (!payload.repo) {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      queued.clear();
      queued.set(key, payload);
    } else {
      if (queued.has("*")) return;
      const previous = queued.get(key);
      const sameWorktree =
        previous &&
        "worktree" in previous &&
        "worktree" in payload &&
        (previous.worktree ?? null) === (payload.worktree ?? null);
      queued.set(key, !previous || sameWorktree ? payload : { repo: payload.repo });
    }

    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      const next = queued.get(key);
      queued.delete(key);
      if (next) refreshers.current.refreshDiffsForEvent(next);
    }, 250));
  }, []);
  useEffect(() => () => {
    for (const timer of diffRefreshTimers.current.values()) clearTimeout(timer);
    diffRefreshTimers.current.clear();
    queuedDiffPayloads.current.clear();
  }, []);
  useEffect(() => {
    return api.subscribe((type, payload) => {
      const r = refreshers.current;
      if (type === DAEMON_EVENTS.threadChanged) {
        r.refreshThreads();
        setPrDraftReloadKey((key) => key + 1);
        setLive("Review threads updated");
      } else if (type === DAEMON_EVENTS.diffChanged) {
        if (followModeRef.current && payload.repo && payload.path) {
          const sel = selectionsRef.current.get(payload.repo) ?? {
            worktree: null,
            target: DEFAULT_TARGET,
          };
          if ((payload.worktree ?? null) === sel.worktree && isFollowableTarget(sel.target)) {
            pendingFollowRef.current = {
              ...payload,
              repo: payload.repo,
              path: payload.path,
              minRefreshSeq: (diffSeqs.current.get(payload.repo) ?? 0) + 1,
            };
          }
        }
        refreshDiffSoon(payload);
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
  }, [refreshDiffSoon]);

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

  const refThreadCountsByRepo = useMemo(() => {
    const map = new Map<string, Map<string, RefThreadCount>>();
    for (const t of threads) {
      if (t.spacePath && t.spacePath !== activeSpacePath) continue;
      if (!t.repo || !t.scope) continue;
      const byRef = map.get(t.repo) ?? new Map<string, RefThreadCount>();
      const count = byRef.get(t.scope.headRef) ?? { open: 0, total: 0 };
      count.total += 1;
      if (t.status === "open") count.open += 1;
      byRef.set(t.scope.headRef, count);
      map.set(t.repo, byRef);
    }
    return map;
  }, [threads, activeSpacePath]);

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
        ? threads.filter((t) => t.repo === null && t.spacePath === activeSpacePath)
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
  const backToDiff = useCallback(() => {
    setPreviewFile(null);
    setSpacePreviewFile(null);
  }, []);

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
  const threadCountsByRepo = useMemo(() => {
    const byRepo = new Map<string, Map<string, number>>();
    for (const r of visibleRepos) {
      const counts = new Map<string, number>();
      for (const t of scopedThreadsByRepo.get(r.name) ?? EMPTY_THREADS) {
        if (t.file === null) continue;
        counts.set(t.file, (counts.get(t.file) ?? 0) + 1);
      }
      byRepo.set(r.name, counts);
    }
    return byRepo;
  }, [visibleRepos, scopedThreadsByRepo]);
  const spaceFileThreadCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of spaceThreads) {
      if (t.targetLevel !== "file" || t.file === null) continue;
      counts.set(t.file, (counts.get(t.file) ?? 0) + 1);
    }
    return counts;
  }, [spaceThreads]);

  const diffStatsByRepo = useMemo(() => {
    const map = new Map<string, { additions: number; deletions: number }>();
    for (const [name, d] of diffs) {
      map.set(name, {
        additions: d.files.reduce((n, f) => n + f.additions, 0),
        deletions: d.files.reduce((n, f) => n + f.deletions, 0),
      });
    }
    return map;
  }, [diffs]);
  const diffFilesByRepo = useMemo(() => {
    const map = new Map<string, DiffFile[]>();
    for (const r of visibleRepos) map.set(r.name, diffs.get(r.name)?.files ?? EMPTY_FILES);
    return map;
  }, [visibleRepos, diffs]);

  const editors = visibleWorkspace?.editors ?? workspace?.editors ?? [];
  const activeEditor = pickEditor(editors, preferredEditor);
  const activeEditorLabel = activeEditor ? editorLabel(activeEditor) : null;
  const setPreferredEditor = useCallback((editorName: string) => {
    setPreferredEditorState(editorName);
    savePreferredEditor(editorName);
  }, []);
  const showOpenError = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  }, []);
  const openWorkspaceInEditor = useCallback(() => {
    if (!activeEditor || !visibleWorkspace) {
      setError("No supported editor found");
      return;
    }
    void api
      .open({ editor: activeEditor, workspacePath: activeEntry?.path ?? visibleWorkspace.root })
      .catch(showOpenError);
  }, [activeEditor, activeEntry?.path, showOpenError, visibleWorkspace]);
  const openFileInEditor = useCallback(
    (repoName: string, fileWorktree: string | null, path: string, line = 1) => {
      if (!activeEditor) {
        setError("No supported editor found");
        return;
      }
      void api
        .open({ editor: activeEditor, repo: repoName, worktree: fileWorktree, file: path, line })
        .catch(showOpenError);
    },
    [activeEditor, showOpenError],
  );
  const openSpaceFileInEditor = useCallback(
    (path: string, line = 1) => {
      if (!activeEditor || !visibleWorkspace) {
        setError("No supported editor found");
        return;
      }
      void api
        .open({
          editor: activeEditor,
          workspacePath: activeEntry?.path ?? visibleWorkspace.root,
          file: path,
          line,
        })
        .catch(showOpenError);
    },
    [activeEditor, activeEntry?.path, showOpenError, visibleWorkspace],
  );
  const openCurrentFileInEditor = useCallback(() => {
    if (!activeFile) return;
    if (spacePreviewFile) {
      openSpaceFileInEditor(spacePreviewFile);
      return;
    }
    if (!repo) return;
    openFileInEditor(repo, worktree, activeFile);
  }, [activeFile, openFileInEditor, openSpaceFileInEditor, repo, spacePreviewFile, worktree]);

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
        <WorkspaceSkeleton />
      </div>
    );
  }

  const desktopShell = isDesktopShell();

  return (
    <div className="app">
      {toast}
      {liveRegion}
      {addOpen && (
        <AddWorkspaceDialog
          onClose={() => setAddOpen(false)}
          onAdded={(nextEntries, addedPath) => {
            const previousPaths = new Set(entries.map((entry) => entry.path));
            setEntries(nextEntries);
            const added =
              nextEntries.find((entry) => entry.path === addedPath) ??
              nextEntries.find((entry) => !previousPaths.has(entry.path));
            const nextPath = added?.path ?? addedPath;
            setActiveWorkspacePath(nextPath);
            const nextRepo = added?.repos[0]?.name ?? null;
            if (nextRepo) selectRepo(nextRepo);
            else setRepo(null);
            setActiveFile(null);
            setSpacePreviewFile(null);
            setPreviewFile(null);
            setWorkspaceRailOpen(false);
          }}
        />
      )}
      <Topbar
        workspace={visibleWorkspace}
        entries={entries}
        activeWorkspacePath={activeEntry?.path ?? visibleWorkspace.root}
        diffStatsByRepo={diffStatsByRepo}
        workspaceRecency={workspaceRecency}
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
        editors={editors}
        editor={activeEditor}
        onEditor={setPreferredEditor}
        onOpenWorkspace={openWorkspaceInEditor}
        onOpenCurrentFile={openCurrentFileInEditor}
        canOpenCurrentFile={activeFile !== null}
      />
      <div className="workbench" ref={workbenchRef} style={paneVars}>
        {workspaceRailOpen && (
          <WorkspaceRail
            workspace={visibleWorkspace}
            entries={entries}
            activeWorkspacePath={activeEntry?.path ?? visibleWorkspace.root}
            diffStatsByRepo={diffStatsByRepo}
            workspaceRecency={workspaceRecency}
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
              legacyCount={legacyCount}
              onSelectRepo={selectRepo}
              onSelectLegacy={selectLegacy}
              spacePath={activeEntry?.path ?? visibleWorkspace.root}
              spaceFiles={spaceFiles}
              filesByRepo={diffFilesByRepo}
              allFilesByRepo={allFilesByRepo}
              ignoredFilesByRepo={ignoredFilesByRepo}
              showIgnoredFiles={showIgnoredFiles}
              onShowIgnoredFilesChange={setShowIgnoredFiles}
              threadCountsByRepo={threadCountsByRepo}
              spaceThreadCounts={spaceFileThreadCounts}
              activeFile={activeFile}
              activeSpaceFile={spacePreviewFile}
              onSelectFile={selectTreeFile}
              onShowDiff={backToDiff}
              onFileModeChange={setSidebarFileMode}
              onCollapse={toggleSidebar}
              editorLabel={activeEditorLabel}
              onOpenRepoFile={(repoName, path) => {
                const sel = selections.get(repoName) ?? { worktree: null, target: DEFAULT_TARGET };
                openFileInEditor(repoName, sel.worktree, path);
              }}
              onOpenSpaceFile={openSpaceFileInEditor}
            />
            <div
              className="sidebar-resizer"
              onMouseDown={startSidebarResize}
              title="Drag to resize"
            />
          </>
        )}
        <main className="layout" style={{ gridTemplateColumns: paneColumns }}>
          <section className="review-main-shell">
            <div className="pane-tabs main-pane-tabs" role="tablist" aria-label="Review view">
              <button
                type="button"
                role="tab"
                aria-selected={mainTab === "diff"}
                className={`pane-tab${mainTab === "diff" ? " active" : ""}`}
                onClick={() => setMainTab("diff")}
              >
                Diff
              </button>
              {desktopShell && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={mainTab === "web"}
                  className={`pane-tab${mainTab === "web" ? " active" : ""}`}
                  onClick={() => setMainTab("web")}
                >
                  Web
                </button>
              )}
              <button
                type="button"
                role="tab"
                aria-selected={mainTab === "pr-draft"}
                className={`pane-tab${mainTab === "pr-draft" ? " active" : ""}`}
                onClick={() => setMainTab("pr-draft")}
              >
                PR Draft
              </button>
              {stacked && mainTab === "diff" && (
                <span className="pane-tab-actions">
                  <button type="button" className="ghost mini" onClick={collapseAllModules}>
                    Collapse all
                  </button>
                  <button type="button" className="ghost mini" onClick={expandAllModules}>
                    Expand all
                  </button>
                </span>
              )}
            </div>
            <div className="review-main-panel" role="tabpanel" hidden={mainTab !== "pr-draft"}>
              <PrDraftPanel
                workspacePath={activeEntry?.path ?? visibleWorkspace.root}
                targets={prDraftTargets}
                reloadKey={prDraftReloadKey}
              />
            </div>
            {desktopShell && (
              <div className="review-main-web" role="tabpanel" hidden={mainTab !== "web"}>
                <WebsiteReviewLauncher
                  visible={mainTab === "web"}
                  repo={repo}
                  spacePath={activeEntry?.path ?? visibleWorkspace.root}
                  worktree={worktree}
                  target={target}
                  onError={setError}
                  onThreadCreated={refreshThreads}
                />
              </div>
            )}
            {mainTab === "diff" && (
              <div className="review-main-content" role="tabpanel">
                {/* N≥2: one module per repo, stacked inside a shared scroll container that
                    owns the scroll-spy ref. N=1: the literal single diff pane, with the
                    pane ref handed straight to it. Each ModuleSection provides its own
                    snapshot context, so the diff side always sees its own repo's snapshot. */}
                {spacePreviewFile ? (
                  <SpaceFilePreview
                    workspacePath={activeEntry?.path ?? visibleWorkspace.root}
                    file={spacePreviewFile}
                    threads={spaceThreads.filter((t) => t.file === spacePreviewFile)}
                    onBackToDiff={backToDiff}
                    onChanged={refreshThreads}
                    editors={editors}
                    editor={activeEditor}
                    onEditor={setPreferredEditor}
                    onOpenFile={openSpaceFileInEditor}
                  />
                ) : stacked ? (
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
                          repoLabel={basename(r.root)}
                          worktree={moduleWorktree}
                          branch={worktreeSummary?.branch ?? null}
                          pullRequest={worktreeSummary?.pullRequest ?? null}
                          diff={diffs.get(r.name) ?? null}
                          threads={scopedThreadsByRepo.get(r.name) ?? EMPTY_THREADS}
                          split={splitView}
                          wrap={wrapLines}
                          theme={theme}
                          target={selections.get(r.name)?.target ?? DEFAULT_TARGET}
                          presentation={selections.get(r.name)?.presentation}
                          refs={refsByRepo.get(r.name) ?? null}
                          refThreadCounts={refThreadCountsByRepo.get(r.name) ?? EMPTY_REF_THREAD_COUNTS}
                          defaultBranch={r.defaultBranch}
                          onTarget={changeTargetFor}
                          collapsed={collapsedRepos.has(r.name)}
                          onToggleCollapse={toggleCollapseFor}
                          previewFile={r.name === repo ? previewFile : null}
                          onBackToDiff={backToDiff}
                          onChanged={refreshThreads}
                          editors={editors}
                          editor={activeEditor}
                          onEditor={setPreferredEditor}
                          onOpenFile={openFileInEditor}
                        />
                      );
                    })}
                  </section>
                ) : (
                  <ModuleSection
                    paneRef={diffPaneRef}
                    repo={repo}
                    repoLabel={activeRepo ? basename(activeRepo.root) : repo}
                    worktree={worktree}
                    branch={activeWorktree?.branch ?? null}
                    pullRequest={activeWorktree?.pullRequest ?? null}
                    diff={diff}
                    threads={scopedThreads}
                    split={splitView}
                    wrap={wrapLines}
                    theme={theme}
                    target={target}
                    presentation={selections.get(repo)?.presentation}
                    refs={refs}
                    refThreadCounts={refThreadCountsByRepo.get(repo) ?? EMPTY_REF_THREAD_COUNTS}
                    defaultBranch={activeRepo?.defaultBranch ?? null}
                    onTarget={changeTargetFor}
                    previewFile={previewFile}
                    onBackToDiff={backToDiff}
                    onChanged={refreshThreads}
                    editors={editors}
                    editor={activeEditor}
                    onEditor={setPreferredEditor}
                    onOpenFile={openFileInEditor}
                  />
                )}
              </div>
            )}
          </section>
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
                      key={`${generalComment.targetLevel}:${generalComment.spacePath}:${generalComment.repo ?? ""}:${generalComment.worktree ?? ""}:${generalComment.target}`}
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
      <StatusBar
        repoLabel={spacePreviewFile ? null : activeRepo ? basename(activeRepo.root) : repo}
        filePath={spacePreviewFile ?? activeFile}
        mode={spacePreviewFile ? "space" : "diff"}
        follow={followMode}
        followAvailable={followAvailable}
        onToggleFollow={toggleFollowMode}
      />
    </div>
  );
}
