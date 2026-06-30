import { useEffect, useRef, useState } from "react";
import type { PrDraft } from "@diffect/shared";
import { api } from "../api.js";
import { Icon } from "../icons.js";
import { MarkdownEditor } from "./MarkdownEditor.js";

export interface PrDraftTarget {
  repo: string;
  worktree: string | null;
}

interface Props {
  workspacePath: string;
  targets: PrDraftTarget[];
  reloadKey?: number;
}

interface EditorProps {
  workspacePath: string;
  target: PrDraftTarget;
  showRepoHeader: boolean;
  reloadKey: number;
}

const AUTOSAVE_DELAY_MS = 1500;

export function PrDraftPanel({ workspacePath, targets, reloadKey = 0 }: Props) {
  const multiRepo = targets.length > 1;

  return (
    <section className="pr-draft-panel" aria-label="PR Draft">
      <div className="pr-draft-intro">Draft the local PR title and body before creating or updating GitHub.</div>
      <div className={multiRepo ? "pr-draft-list" : undefined}>
        {targets.map((target) => (
          <PrDraftEditor
            key={targetKey(target)}
            workspacePath={workspacePath}
            target={target}
            showRepoHeader={multiRepo}
            reloadKey={reloadKey}
          />
        ))}
      </div>
    </section>
  );
}

function PrDraftEditor({ workspacePath, target, showRepoHeader, reloadKey }: EditorProps) {
  const [loaded, setLoaded] = useState<PrDraft | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const saveSeq = useRef(0);
  const loadedRef = useRef<PrDraft | null>(null);
  const titleRef = useRef(title);
  const bodyRef = useRef(body);

  loadedRef.current = loaded;
  titleRef.current = title;
  bodyRef.current = body;

  const dirty = loaded ? title !== loaded.title || body !== loaded.body : false;

  useEffect(() => {
    let live = true;
    api
      .prDraft(workspacePath, target.repo, target.worktree)
      .then((draft) => {
        if (!live) return;
        const currentLoaded = loadedRef.current;
        const currentDirty = currentLoaded
          ? titleRef.current !== currentLoaded.title || bodyRef.current !== currentLoaded.body
          : false;
        if (currentDirty && (titleRef.current !== draft.title || bodyRef.current !== draft.body)) return;
        setLoaded(draft);
        setTitle(draft.title);
        setBody(draft.body);
        setError(null);
      })
      .catch((err) => live && setError(String(err)));
    return () => {
      live = false;
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    };
  }, [workspacePath, target.repo, target.worktree, reloadKey]);

  useEffect(() => {
    if (!loaded || !dirty) return;
    const timer = window.setTimeout(() => void save(title, body), AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [body, dirty, loaded, title, workspacePath]);

  const save = async (nextTitle = titleRef.current, nextBody = bodyRef.current) => {
    const seq = ++saveSeq.current;
    setSaving(true);
    setError(null);
    try {
      const next = await api.updatePrDraft(workspacePath, target.repo, target.worktree, {
        title: nextTitle,
        body: nextBody,
      });
      if (seq === saveSeq.current) setLoaded(next);
    } catch (err) {
      if (seq === saveSeq.current) setError(String(err));
    } finally {
      if (seq === saveSeq.current) setSaving(false);
    }
  };

  const copyBody = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1400);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className={`pr-draft-editor${showRepoHeader ? " pr-draft-card" : ""}`}>
      <div className="pr-draft-headline">
        {showRepoHeader && <h3>{targetLabel(target)}</h3>}
        <button
          type="button"
          className="icon-btn pr-copy"
          aria-label={`Copy PR body${showRepoHeader ? ` for ${targetLabel(target)}` : ""}`}
          title="Copy PR body"
          onClick={copyBody}
          disabled={!loaded || !body}
        >
          <Icon name={copied ? "check" : "copy"} size={15} />
        </button>
      </div>

      <label className="pr-field">
        <span>Title</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="PR title"
          disabled={!loaded}
        />
      </label>

      <div className="pr-field">
        <span>Body</span>
        <MarkdownEditor
          value={body}
          onChange={setBody}
          placeholder="Summarize the change, validation, risks, and screenshots."
          ariaLabel={`PR body${showRepoHeader ? ` for ${targetLabel(target)}` : ""}`}
          height={showRepoHeader ? 360 : 460}
          disabled={!loaded}
          onSubmitKey={() => void save()}
        />
      </div>

      {!loaded && !error && <div className="pr-updated">Loading PR Draft…</div>}
      {loaded && dirty && <div className="pr-updated">{saving ? "Saving…" : "Unsaved changes"}</div>}
      {loaded?.updatedAt && !dirty && <div className="pr-updated">Last saved {formatTime(loaded.updatedAt)}</div>}
      {error && <div className="error">{error}</div>}
      <div className="pr-actions">
        {copied && <span className="pr-copied">Copied</span>}
        <button type="button" className="primary" disabled={!loaded || !dirty || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function targetKey(target: PrDraftTarget): string {
  return `${target.repo}::${target.worktree ?? ""}`;
}

function targetLabel(target: PrDraftTarget): string {
  return target.worktree ? `${target.repo} (${target.worktree})` : target.repo;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
