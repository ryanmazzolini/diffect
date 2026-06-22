import { useState } from "react";
import type { ThreadTargetLevel } from "@diffect/shared";
import { api } from "../api.js";
import { useDraft } from "../useDraft.js";
import { MarkdownEditor } from "./MarkdownEditor.js";

interface Props {
  repo: string | null;
  spacePath: string;
  worktree: string | null;
  target: string;
  targetLevel: Exclude<ThreadTargetLevel, "file">;
  label: string;
  onCancel: () => void;
  onCreated: () => void;
}

export function GeneralCommentForm({
  repo,
  spacePath,
  worktree,
  target,
  targetLevel,
  label,
  onCancel,
  onCreated,
}: Props) {
  const [body, setBody, clearDraft] = useDraft(
    `draft-general:${targetLevel}:${spacePath}:${repo ?? ""}:${worktree ?? ""}:${target}`,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!body.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.createThread({
        repo,
        spacePath,
        worktree,
        target,
        targetLevel,
        file: null,
        side: null,
        line: null,
        body: body.trim(),
      });
      clearDraft();
      onCreated();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="comment-form general-comment-form">
      <MarkdownEditor
        autoFocus
        placeholder={`Comment on this ${targetLevel}: ${label}`}
        value={body}
        onChange={setBody}
        onSubmitKey={submit}
        onCancelKey={onCancel}
      />
      <div className="comment-form-actions">
        <span className="comment-form-context">{label}</span>
        <span className="spacer" />
        <button className="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button className="primary" onClick={submit} disabled={submitting || !body.trim()}>
          {submitting ? "Saving…" : "Comment"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
