import { useLayoutEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { Icon, type IconName } from "../icons.js";
import {
  insertLink,
  prefixLines,
  wrapSelection,
  type EditResult,
} from "../markdownEdit.js";
import { Markdown } from "./Markdown.js";

type Transform = (value: string, start: number, end: number) => EditResult;

interface Tool {
  key: string;
  title: string;
  icon?: IconName;
  text?: string;
  /** Cmd/Ctrl shortcut letter, if any. */
  shortcut?: string;
  run: Transform;
}

const TOOLS: Tool[] = [
  { key: "h", title: "Heading", text: "H", run: (v, s, e) => prefixLines(v, s, e, () => "### ") },
  { key: "bold", title: "Bold (⌘B)", icon: "bold", shortcut: "b", run: (v, s, e) => wrapSelection(v, s, e, "**") },
  { key: "italic", title: "Italic (⌘I)", icon: "italic", shortcut: "i", run: (v, s, e) => wrapSelection(v, s, e, "_") },
  { key: "quote", title: "Quote", icon: "quote", run: (v, s, e) => prefixLines(v, s, e, () => "> ") },
  { key: "code", title: "Code", icon: "code", run: (v, s, e) => wrapSelection(v, s, e, "`") },
  { key: "link", title: "Link (⌘K)", icon: "link", shortcut: "k", run: insertLink },
  { key: "ul", title: "Bulleted list", icon: "list-unordered", run: (v, s, e) => prefixLines(v, s, e, () => "- ") },
  { key: "ol", title: "Numbered list", icon: "list-ordered", run: (v, s, e) => prefixLines(v, s, e, (i) => `${i + 1}. `) },
  { key: "task", title: "Task list", icon: "tasklist", run: (v, s, e) => prefixLines(v, s, e, () => "- [ ] ") },
];

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Cmd/Ctrl+Enter. */
  onSubmitKey?: () => void;
  /** Escape. */
  onCancelKey?: () => void;
}

/** GitHub-style markdown composer: Write/Preview tabs + a formatting toolbar. */
export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  autoFocus,
  onSubmitKey,
  onCancelKey,
}: Props) {
  const [tab, setTab] = useState<"write" | "preview">("write");
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Selection to restore after a toolbar edit re-renders the controlled textarea.
  const pendingSel = useRef<[number, number] | null>(null);

  // Runs every render but is a no-op unless a toolbar edit just stashed a
  // selection — so it never steals focus on unrelated re-renders.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (pendingSel.current && ta) {
      ta.focus();
      ta.setSelectionRange(pendingSel.current[0], pendingSel.current[1]);
      pendingSel.current = null;
    }
  });

  const apply = (run: Transform) => {
    const ta = taRef.current;
    if (!ta) return;
    const r = run(value, ta.selectionStart, ta.selectionEnd);
    pendingSel.current = [r.selStart, r.selEnd];
    onChange(r.value);
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const insertAtCaret = (text: string) => {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e, value: cur } = ta;
    pendingSel.current = [s + text.length, s + text.length];
    onChange(cur.slice(0, s) + text + cur.slice(e));
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    for (const file of Array.from(files)) {
      try {
        const { url, name } = await api.uploadAttachment(file);
        // Strip markdown-link metacharacters from the (user-controlled) filename
        // so it can't break out of the [label](url) construct.
        const label = name.replace(/[[\]()\r\n]/g, " ").trim() || "attachment";
        // Images embed inline (![]); other files become plain links.
        const bang = file.type.startsWith("image/") ? "!" : "";
        insertAtCaret(`${bang}[${label}](${url})\n`);
      } catch (err) {
        setUploadError(String(err));
      }
    }
    setUploading(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return onCancelKey?.();
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === "Enter") return onSubmitKey?.();
    const tool = TOOLS.find((t) => t.shortcut === e.key.toLowerCase());
    if (tool) {
      e.preventDefault();
      apply(tool.run);
    }
  };

  return (
    <div className="md-editor">
      <div className="md-tabs">
        <div className="md-tablist" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "write"}
            className={`md-tab ${tab === "write" ? "active" : ""}`}
            onClick={() => setTab("write")}
          >
            Write
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "preview"}
            className={`md-tab ${tab === "preview" ? "active" : ""}`}
            onClick={() => setTab("preview")}
          >
            Preview
          </button>
        </div>
        {tab === "write" && (
          <div className="md-toolbar">
            {TOOLS.map((t) => (
              <button
                type="button"
                key={t.key}
                className="md-tool icon-btn"
                title={t.title}
                aria-label={t.title}
                // Keep textarea focus/selection; act on mousedown before blur.
                onMouseDown={(e) => {
                  e.preventDefault();
                  apply(t.run);
                }}
              >
                {t.icon ? <Icon name={t.icon} size={14} /> : t.text}
              </button>
            ))}
            <button
              type="button"
              className="md-tool icon-btn"
              title="Attach a file"
              aria-label="Attach a file"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
            >
              <Icon name="paperclip" size={14} />
            </button>
          </div>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void uploadFiles(e.target.files);
          e.target.value = ""; // let the same file be re-selected later
        }}
      />
      {tab === "write" ? (
        <textarea
          ref={taRef}
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (e.clipboardData.files.length > 0) {
              e.preventDefault();
              void uploadFiles(e.clipboardData.files);
            }
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            if (e.dataTransfer.files.length > 0) {
              e.preventDefault();
              void uploadFiles(e.dataTransfer.files);
            }
          }}
        />
      ) : (
        <div className="md-preview">
          {value.trim() ? <Markdown>{value}</Markdown> : <span className="muted">Nothing to preview</span>}
        </div>
      )}
      {uploading && <div className="md-uploading">Uploading…</div>}
      {uploadError && <div className="error">{uploadError}</div>}
    </div>
  );
}
