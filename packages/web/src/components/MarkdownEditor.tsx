import { useLayoutEffect, useRef, useState, type DragEvent } from "react";
import MDEditor, {
  commands,
  type ICommand,
  type RefMDEditor,
} from "@uiw/react-md-editor/nohighlight";
import { api } from "../api.js";
import { Icon } from "../icons.js";
import { Markdown } from "./Markdown.js";

const headingCommand: ICommand = {
  ...commands.title3,
  icon: <strong>H</strong>,
  buttonProps: { "aria-label": "Heading", title: "Heading" },
};

const linkCommand: ICommand = {
  ...commands.link,
  shortcuts: "ctrlcmd+k",
  buttonProps: { "aria-label": "Add a link (ctrl + k)", title: "Add a link (ctrl + k)" },
};

const EDITOR_COMMANDS: ICommand[] = [
  headingCommand,
  commands.bold,
  commands.italic,
  commands.quote,
  commands.code,
  linkCommand,
  commands.unorderedListCommand,
  commands.orderedListCommand,
  commands.checkedListCommand,
];

type EditorMode = "edit" | "preview";

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Cmd/Ctrl+Enter. */
  onSubmitKey?: () => void;
  /** Escape. */
  onCancelKey?: () => void;
  height?: number;
  ariaLabel?: string;
  disabled?: boolean;
}

function moveCaretToLineEdge(
  textarea: HTMLTextAreaElement,
  end: boolean,
  extend: boolean,
  wholeText: boolean,
): void {
  const value = textarea.value;
  const pos = end ? textarea.selectionEnd : textarea.selectionStart;
  let next: number;
  if (wholeText) {
    next = end ? value.length : 0;
  } else if (end) {
    const lineEnd = value.indexOf("\n", pos);
    next = lineEnd === -1 ? value.length : lineEnd;
  } else {
    next = value.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  }
  if (!extend) {
    textarea.setSelectionRange(next, next);
  } else if (end) {
    textarea.setSelectionRange(textarea.selectionStart, next);
  } else {
    textarea.setSelectionRange(next, textarea.selectionEnd);
  }
}

/** Sanitized markdown composer with GitHub-ish textarea behavior. */
export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  autoFocus,
  onSubmitKey,
  onCancelKey,
  height = 96,
  ariaLabel,
  disabled,
}: Props) {
  const editorRef = useRef<RefMDEditor>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  const pendingSel = useRef<[number, number] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [mode, setMode] = useState<EditorMode>("edit");
  const [draggingFiles, setDraggingFiles] = useState(false);
  const dragDepth = useRef(0);

  valueRef.current = value;

  useLayoutEffect(() => {
    const ta = editorRef.current?.textarea;
    if (pendingSel.current && ta) {
      ta.focus();
      ta.setSelectionRange(pendingSel.current[0], pendingSel.current[1]);
      pendingSel.current = null;
    }
  });

  const insertAtCaret = (text: string) => {
    const ta = editorRef.current?.textarea;
    const cur = ta?.value ?? valueRef.current;
    const s = ta?.selectionStart ?? cur.length;
    const e = ta?.selectionEnd ?? cur.length;
    const next = cur.slice(0, s) + text + cur.slice(e);
    valueRef.current = next;
    pendingSel.current = [s + text.length, s + text.length];
    onChange(next);
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    for (const file of Array.from(files)) {
      try {
        const { url, name } = await api.uploadAttachment(file);
        const label = name.replace(/[[\]()\r\n]/g, " ").trim() || "attachment";
        insertAtCaret(`${file.type.startsWith("image/") ? "!" : ""}[${label}](${url})\n`);
      } catch (err) {
        setUploadError(String(err));
      }
    }
    setUploading(false);
  };

  const hasFiles = (e: DragEvent<HTMLDivElement>) =>
    e.dataTransfer.files.length > 0 || Array.from(e.dataTransfer.types).includes("Files");

  const resetDrag = () => {
    dragDepth.current = 0;
    setDraggingFiles(false);
  };

  const attachCommand: ICommand = {
    name: "attach",
    keyCommand: "attach",
    buttonProps: { "aria-label": "Attach a file", title: "Attach a file" },
    icon: <Icon name="paperclip" size={14} />,
    execute: () => {
      if (!disabled) fileInputRef.current?.click();
    },
  };

  return (
    <div
      className={`md-editor${draggingFiles ? " is-dragging" : ""}`}
      onKeyDown={(e) => {
        if (e.key === "Home" || e.key === "End") e.stopPropagation();
      }}
      onDragEnterCapture={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        dragDepth.current += 1;
        setDraggingFiles(true);
      }}
      onDragOverCapture={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = disabled ? "none" : "copy";
      }}
      onDragLeaveCapture={(e) => {
        if (!hasFiles(e)) return;
        e.stopPropagation();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDraggingFiles(false);
      }}
      onDropCapture={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        resetDrag();
        if (!disabled) void uploadFiles(e.dataTransfer.files);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        disabled={disabled}
        onChange={(e) => {
          void uploadFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <div className="md-editor-tabs" role="tablist" aria-label="Markdown mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "edit"}
          onClick={() => setMode("edit")}
          disabled={disabled && mode !== "edit"}
        >
          Write
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "preview"}
          onClick={() => setMode("preview")}
          disabled={disabled && mode !== "preview"}
        >
          Preview
        </button>
      </div>
      <MDEditor
        ref={editorRef}
        value={value}
        onChange={(next) => onChange(next ?? "")}
        autoFocus={autoFocus}
        preview={mode}
        height={height}
        minHeight={56}
        visibleDragbar={false}
        commands={EDITOR_COMMANDS}
        extraCommands={[attachCommand]}
        components={{
          preview: (source) => <Markdown>{source}</Markdown>,
        }}
        textareaProps={{
          "aria-label": ariaLabel,
          disabled,
          placeholder,
          onKeyDown: (e) => {
            if (e.key === "Home" || e.key === "End") {
              e.preventDefault();
              e.stopPropagation();
              moveCaretToLineEdge(
                e.currentTarget,
                e.key === "End",
                e.shiftKey,
                e.metaKey || e.ctrlKey,
              );
            }
            if (e.key === "Escape") onCancelKey?.();
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onSubmitKey?.();
          },
          onPaste: (e) => {
            if (e.clipboardData.files.length > 0) {
              e.preventDefault();
              void uploadFiles(e.clipboardData.files);
            }
          },
        }}
      />
      {uploading && <div className="md-uploading">Uploading…</div>}
      {uploadError && <div className="error">{uploadError}</div>}
    </div>
  );
}
