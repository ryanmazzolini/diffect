import { useEffect, useMemo, useState } from "react";
import {
  parseDiffFromFile,
  type CodeViewDiffItem,
  type CodeViewLineSelection,
} from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import type {
  CreateReviewRequest,
  ReviewDetail,
  ReviewDiff,
  ReviewThreadDetail,
  ReviewThreadLocation,
  Side,
  WorkspaceRepository,
  WorkspaceSummary,
} from "@diffect/shared";
import { api, ApiError } from "./api.js";

type AnnotationMetadata =
  | { kind: "composer" }
  | { kind: "thread"; thread: ReviewThreadDetail };

interface LoadedSurface {
  repository: WorkspaceRepository | null;
  worktreeName: string | null;
  review: ReviewDetail | null;
  reviewLink: string | null;
  diff: ReviewDiff | null;
  codeUnavailable: string | null;
}

const PIERRE_CSS = `
:host {
  --diffs-font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --diffs-font-size: 12px;
}
[data-line-selected], [data-selected-line] {
  outline: 1px solid #72a7ff;
  background: rgba(79, 133, 214, .28) !important;
}
`;

export function App() {
  const directReviewId = reviewIdFromPath(window.location.pathname);
  const query = new URLSearchParams(window.location.search);
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const [selectedRepo, setSelectedRepo] = useState(query.get("repo") ?? "");
  const [selectedWorktree, setSelectedWorktree] = useState<string | null>(
    query.get("worktree"),
  );
  const [surface, setSurface] = useState<LoadedSurface | null>(null);
  const [selection, setSelection] = useState<CodeViewLineSelection | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        if (directReviewId) {
          const { review, link } = await api.review(directReviewId);
          let diff: ReviewDiff | null = null;
          let codeUnavailable: string | null = null;
          try {
            diff = await api.reviewDiff(directReviewId);
          } catch (diffError) {
            if (diffError instanceof ApiError && diffError.status === 409) {
              codeUnavailable = diffError.message;
            } else {
              throw diffError;
            }
          }
          if (!cancelled) {
            setSurface({
              repository: null,
              worktreeName: diff?.worktree ?? null,
              review,
              reviewLink: link,
              diff,
              codeUnavailable,
            });
          }
          return;
        }

        const summary = await api.workspace();
        const repository =
          summary.repos.find((repo) => repo.name === selectedRepo) ??
          (summary.repos.length === 1 ? summary.repos[0] : null);
        if (!cancelled) setWorkspace(summary);
        if (!repository) {
          if (!cancelled) setSurface(null);
          return;
        }
        const worktree = selectedWorktree
          ? repository.worktrees.find((candidate) => candidate.name === selectedWorktree)
          : repository.worktrees.find((candidate) => candidate.root === summary.root) ??
            repository.worktrees.find((candidate) => candidate.root === repository.root);
        if (!worktree) throw new Error("The selected worktree is no longer available.");
        const current = await api.currentChanges(
          repository.name,
          worktree.root === repository.root ? null : worktree.name,
        );
        if (!cancelled) {
          setSelectedRepo(repository.name);
          setSelectedWorktree(
            worktree.root === repository.root ? null : worktree.name,
          );
          setSurface({
            repository: current.repository,
            worktreeName:
              current.worktree.root === current.repository.root
                ? null
                : current.worktree.name,
            review: current.review,
            reviewLink: current.review
              ? `http://127.0.0.1:7421/reviews/${current.review.id}`
              : null,
            diff: current.diff,
            codeUnavailable: null,
          });
        }
      } catch (loadError) {
        if (!cancelled) setError(messageOf(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [directReviewId, selectedRepo, selectedWorktree]);

  const threads = surface?.review?.threads ?? [];
  const items = useMemo(
    () => buildItems(surface?.diff ?? null, threads, selection),
    [surface?.diff, threads, selection],
  );

  function selectRepository(name: string) {
    setSelection(null);
    setSelectedWorktree(null);
    setSelectedRepo(name);
    const next = new URL(window.location.href);
    next.pathname = "/";
    next.search = name ? `?repo=${encodeURIComponent(name)}` : "";
    window.history.replaceState(null, "", next);
  }

  function selectWorktree(name: string) {
    setSelection(null);
    const value = name || null;
    setSelectedWorktree(value);
    const next = new URL(window.location.href);
    next.pathname = "/";
    next.searchParams.set("repo", selectedRepo);
    if (value) next.searchParams.set("worktree", value);
    else next.searchParams.delete("worktree");
    window.history.replaceState(null, "", next);
  }

  async function submit(body: string) {
    if (!surface?.diff || !selection || surface.review) return;
    const location = locationFromSelection(selection);
    if (!location) throw new Error("Select a range on one side of the diff.");
    const request: CreateReviewRequest = {
      repo: surface.diff.repo ?? selectedRepo,
      worktree: surface.diff.worktree ?? null,
      location,
      severity: null,
      author: { type: "user" },
      body,
    };
    try {
      const created = await api.createReview(request);
      setSurface((current) =>
        current
          ? { ...current, review: created.review, reviewLink: created.link }
          : current,
      );
      setSelection(null);
      window.history.replaceState(
        null,
        "",
        `/reviews/${created.review.id}${window.location.search}`,
      );
    } catch (submitError) {
      if (submitError instanceof ApiError && submitError.status === 409) {
        const payload = submitError.payload as Partial<{
          review: ReviewDetail;
          link: string;
        }>;
        if (payload.review && payload.link) {
          setSurface((current) =>
            current
              ? { ...current, review: payload.review!, reviewLink: payload.link! }
              : current,
          );
          setSelection(null);
          window.history.replaceState(null, "", `/reviews/${payload.review.id}`);
          return;
        }
      }
      throw submitError;
    }
  }

  if (loading) return <StateMessage title="Loading Review…" />;
  if (error) return <StateMessage title="Review unavailable" detail={error} />;
  if (!surface) {
    return (
      <StateMessage
        title={workspace?.repos.length ? "Choose a repository" : "No repository found"}
        detail="Diffect needs one registered Git workspace before it can show Current changes."
      />
    );
  }

  const currentRepository =
    workspace?.repos.find((repo) => repo.name === selectedRepo) ?? surface.repository;
  const review = surface.review;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="Diffect">
          <span className="brand-mark" aria-hidden="true">D</span>
          <span>Diffect</span>
        </div>
        <div className="surface-title">
          <span className="eyebrow">{review ? "Review" : "Current changes"}</span>
          <strong>{surface.diff?.repo ?? repositoryName(review)}</strong>
        </div>
        <div className="topbar-actions">
          {!directReviewId && workspace && workspace.repos.length > 1 ? (
            <label className="compact-field">
              <span>Repository</span>
              <select value={selectedRepo} onChange={(event) => selectRepository(event.target.value)}>
                {workspace.repos.map((repo) => (
                  <option key={repo.name} value={repo.name}>{repo.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          {!directReviewId && currentRepository && currentRepository.worktrees.length > 1 ? (
            <label className="compact-field">
              <span>Worktree</span>
              <select value={selectedWorktree ?? ""} onChange={(event) => selectWorktree(event.target.value)}>
                {currentRepository.worktrees.map((worktree) => (
                  <option
                    key={worktree.root}
                    value={worktree.root === currentRepository.root ? "" : worktree.name}
                  >
                    {worktree.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {review && surface.reviewLink ? (
            <CopyButton value={surface.reviewLink} label={shortReviewId(review.id)} />
          ) : (
            <button className="secondary-button" type="button" onClick={() => setKeyboardOpen((open) => !open)}>
              Comment by line
            </button>
          )}
        </div>
      </header>

      {keyboardOpen && !review && surface.diff ? (
        <KeyboardRangeForm
          diff={surface.diff}
          onCancel={() => setKeyboardOpen(false)}
          onSelect={(nextSelection) => {
            setSelection(nextSelection);
            setKeyboardOpen(false);
          }}
        />
      ) : null}

      <main className="review-surface">
        <div className="surface-toolbar">
          <span>
            {surface.diff
              ? `${surface.diff.files.length} changed ${surface.diff.files.length === 1 ? "file" : "files"}`
              : "Code unavailable"}
          </span>
          <span className="toolbar-path">
            {selection ? locatorFromSelection(selection) : "Select a line range to comment"}
          </span>
        </div>
        {!surface.diff && review ? (
          <UnavailableReview
            review={review}
            detail={surface.codeUnavailable ?? "The Review checkout is unavailable."}
          />
        ) : items.length === 0 ? (
          <StateMessage title="No current changes" detail="This working tree matches its current base." />
        ) : (
          <CodeView<AnnotationMetadata>
            items={items}
            selectedLines={selection}
            onSelectedLinesChange={review ? undefined : setSelection}
            disableWorkerPool
            options={{
              theme: "vesper",
              themeType: "dark",
              diffStyle: "unified",
              diffIndicators: "bars",
              overflow: "scroll",
              expandUnchanged: false,
              lineHoverHighlight: "both",
              enableLineSelection: !review,
              controlledSelection: true,
              stickyHeaders: true,
              unsafeCSS: PIERRE_CSS,
            }}
            renderHeaderMetadata={(item) => (
              <span className="file-meta">
                {item.type === "diff" ? item.fileDiff.name : item.file.name}
              </span>
            )}
            renderAnnotation={(annotation) => {
              const metadata = annotation.metadata;
              if (metadata.kind === "thread") {
                return <ThreadAnnotation thread={metadata.thread} />;
              }
              return selection ? (
                <InlineComposer
                  locator={locatorFromSelection(selection)}
                  onCancel={() => setSelection(null)}
                  onSubmit={submit}
                />
              ) : null;
            }}
          />
        )}
      </main>
    </div>
  );
}

function buildItems(
  diff: ReviewDiff | null,
  threads: ReviewThreadDetail[],
  selection: CodeViewLineSelection | null,
): CodeViewDiffItem<AnnotationMetadata>[] {
  if (!diff) return [];
  return diff.files.flatMap((file) => {
    if (file.old === null || file.new === null) return [];
    const fileDiff = parseDiffFromFile(
      { name: file.oldPath ?? file.path, contents: file.old },
      { name: file.path, contents: file.new },
    );
    const annotations: CodeViewDiffItem<AnnotationMetadata>["annotations"] = threads
      .filter((thread) => thread.location.path === file.path)
      .map((thread) => ({
        side: thread.location.side === "new" ? "additions" : "deletions",
        lineNumber: thread.location.endLine,
        metadata: { kind: "thread", thread },
      }));
    if (selection?.id === file.path) {
      const side = selection.range.endSide ?? selection.range.side ?? "additions";
      annotations.push({
        side,
        lineNumber: selection.range.end,
        metadata: { kind: "composer" },
      });
    }
    return [
      {
        id: file.path,
        type: "diff",
        fileDiff,
        annotations,
        version: threads.length * 2 + (selection?.id === file.path ? 1 : 0),
      },
    ];
  });
}

export function locationFromSelection(
  selection: CodeViewLineSelection,
): ReviewThreadLocation | null {
  const startSide = selection.range.side ?? "additions";
  const endSide = selection.range.endSide ?? startSide;
  if (startSide !== endSide) return null;
  return {
    path: selection.id,
    side: startSide === "additions" ? "new" : "old",
    startLine: Math.min(selection.range.start, selection.range.end),
    endLine: Math.max(selection.range.start, selection.range.end),
  };
}

function locatorFromSelection(selection: CodeViewLineSelection): string {
  const location = locationFromSelection(selection);
  return location
    ? `${location.path}:${location.startLine}-${location.endLine}`
    : `${selection.id}:mixed-side selection`;
}

export function reviewIdFromPath(path: string): string | null {
  const match = /^\/reviews\/(rvw_[a-f0-9]{32})\/?$/.exec(path);
  return match?.[1] ?? null;
}

function repositoryName(review: ReviewDetail | null): string {
  if (!review) return "Repository";
  return review.repository.root.split(/[/\\]/).filter(Boolean).at(-1) ?? "Repository";
}

function shortReviewId(id: string): string {
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lineCount(content: string | null): number {
  if (!content) return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

function KeyboardRangeForm({
  diff,
  onSelect,
  onCancel,
}: {
  diff: ReviewDiff;
  onSelect(selection: CodeViewLineSelection): void;
  onCancel(): void;
}) {
  const first = diff.files.find((file) => file.new !== null || file.old !== null);
  const [path, setPath] = useState(first?.path ?? "");
  const [side, setSide] = useState<Side>(first?.new !== null ? "new" : "old");
  const [start, setStart] = useState(1);
  const [end, setEnd] = useState(1);
  const [error, setError] = useState<string | null>(null);

  function place() {
    const file = diff.files.find((candidate) => candidate.path === path);
    const maximum = file ? lineCount(file[side]) : 0;
    if (!file || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > maximum) {
      setError(`Enter a range between 1 and ${maximum}.`);
      return;
    }
    const pierreSide = side === "new" ? "additions" : "deletions";
    onSelect({
      id: path,
      range: { start, end, side: pierreSide, endSide: pierreSide },
    });
  }

  return (
    <section className="keyboard-range" aria-label="Choose comment line range">
      <label>
        File
        <select value={path} onChange={(event) => setPath(event.target.value)}>
          {diff.files.map((file) => <option key={file.path}>{file.path}</option>)}
        </select>
      </label>
      <label>
        Side
        <select value={side} onChange={(event) => setSide(event.target.value as Side)}>
          <option value="new">New</option>
          <option value="old">Old</option>
        </select>
      </label>
      <label>
        Start line
        <input type="number" min={1} value={start} onChange={(event) => setStart(Number(event.target.value))} />
      </label>
      <label>
        End line
        <input type="number" min={start} value={end} onChange={(event) => setEnd(Number(event.target.value))} />
      </label>
      <div className="range-actions">
        <button type="button" className="secondary-button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary-button" onClick={place}>Place composer</button>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </section>
  );
}

function InlineComposer({
  locator,
  onSubmit,
  onCancel,
}: {
  locator: string;
  onSubmit(body: string): Promise<void>;
  onCancel(): void;
}) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!body.trim()) {
      setError("Write a comment before submitting.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(body);
    } catch (submitError) {
      setError(messageOf(submitError));
      setSubmitting(false);
    }
  }

  return (
    <form
      className="inline-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="composer-header">
        <CopyButton value={locator} label={locator} />
        <button type="button" className="quiet-button" onClick={onCancel}>Close</button>
      </div>
      <label>
        <span className="sr-only">Review comment</span>
        <textarea
          autoFocus
          rows={4}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Leave feedback on this range…"
        />
      </label>
      <div className="composer-actions">
        {error ? <span className="form-error" role="alert">{error}</span> : <span />}
        <button className="primary-button" type="submit" disabled={submitting}>
          {submitting ? "Creating Review…" : "Add comment"}
        </button>
      </div>
    </form>
  );
}

function ThreadAnnotation({ thread }: { thread: ReviewThreadDetail }) {
  const comment = thread.comments[0];
  return (
    <article className="thread-annotation">
      <header>
        <strong>{comment?.author.type === "agent" ? comment.author.name ?? "Agent" : "You"}</strong>
        {thread.severity ? <span>{thread.severity}</span> : null}
        <code>{thread.location.path}:{thread.location.startLine}-{thread.location.endLine}</code>
      </header>
      <p>{comment?.body}</p>
    </article>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }
  return (
    <button type="button" className="copy-button" onClick={() => void copy()} title={value}>
      {copied ? "Copied" : label}
    </button>
  );
}

function UnavailableReview({
  review,
  detail,
}: {
  review: ReviewDetail;
  detail: string;
}) {
  return (
    <section className="unavailable-review" aria-labelledby="code-unavailable-title">
      <div>
        <h1 id="code-unavailable-title">Code unavailable</h1>
        <p>{detail}</p>
        <p>The Review metadata and conversation remain available by ID.</p>
      </div>
      <div className="unavailable-threads">
        {review.threads.map((thread) => (
          <ThreadAnnotation key={thread.id} thread={thread} />
        ))}
      </div>
    </section>
  );
}

function StateMessage({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="state-message" role={title.includes("unavailable") ? "alert" : undefined}>
      <h1>{title}</h1>
      {detail ? <p>{detail}</p> : null}
    </div>
  );
}
