import { useLayoutEffect, useRef, useState } from "react";
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

const PREVIEW_COMMANDS: ICommand[] = [commands.codeEdit, commands.codePreview];

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

/** Sanitized markdown composer with GitHub-ish textarea behavior. */
export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  autoFocus,
  onSubmitKey,
  onCancelKey,
}: Props) {
  const editorRef = useRef<RefMDEditor>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  const pendingSel = useRef<[number, number] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

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

  const attachCommand: ICommand = {
    name: "attach",
    keyCommand: "attach",
    buttonProps: { "aria-label": "Attach a file", title: "Attach a file" },
    icon: <Icon name="paperclip" size={14} />,
    execute: () => fileInputRef.current?.click(),
  };

  return (
    <div className="md-editor">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void uploadFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <MDEditor
        ref={editorRef}
        value={value}
        onChange={(next) => onChange(next ?? "")}
        autoFocus={autoFocus}
        preview="edit"
        height={96}
        minHeight={56}
        visibleDragbar={false}
        commands={EDITOR_COMMANDS}
        extraCommands={[attachCommand, commands.divider, ...PREVIEW_COMMANDS]}
        components={{
          preview: (source) => <Markdown>{source}</Markdown>,
        }}
        textareaProps={{
          placeholder,
          onKeyDown: (e) => {
            if (e.key === "Escape") onCancelKey?.();
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onSubmitKey?.();
          },
          onPaste: (e) => {
            if (e.clipboardData.files.length > 0) {
              e.preventDefault();
              void uploadFiles(e.clipboardData.files);
            }
          },
          onDragOver: (e) => e.preventDefault(),
          onDrop: (e) => {
            if (e.dataTransfer.files.length > 0) {
              e.preventDefault();
              void uploadFiles(e.dataTransfer.files);
            }
          },
        }}
      />
      {uploading && <div className="md-uploading">Uploading…</div>}
      {uploadError && <div className="error">{uploadError}</div>}
    </div>
  );
}
