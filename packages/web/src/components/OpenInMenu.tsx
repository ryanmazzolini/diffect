import { useEffect, useRef } from "react";
import { EditorIcon } from "../editorIcons.js";
import { editorLabel } from "../editorPreference.js";
import { Icon } from "../icons.js";

interface OpenInAction {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

interface Props {
  editors: string[];
  editor: string | null;
  onEditor: (editor: string) => void;
  actions?: OpenInAction[];
  primaryAction?: () => void;
  className?: string;
}

export function OpenInMenu({
  editors,
  editor,
  onEditor,
  actions = [],
  primaryAction,
  className = "",
}: Props) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
  };

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const details = detailsRef.current;
      if (!details || !details.open) return;
      if (event.target instanceof Node && !details.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  if (!editor) {
    return <button type="button" className="ghost open-in-trigger" disabled>No editor</button>;
  }

  const label = `Open in ${editorLabel(editor)}`;
  const popover = (
    <div className="open-in-popover">
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          className="open-in-item"
          onClick={() => {
            action.onSelect();
            close();
          }}
          disabled={action.disabled}
        >
          <EditorIcon editor={editor} size={16} />
          <span>{action.label}</span>
        </button>
      ))}
      {actions.length > 0 && <div className="open-in-divider" />}
      <div className="open-in-label">Preferred editor</div>
      {editors.map((name) => (
        <button
          key={name}
          type="button"
          className={`open-in-item ${name === editor ? "active" : ""}`}
          onClick={() => {
            onEditor(name);
            close();
          }}
        >
          <EditorIcon editor={name} size={16} />
          <span>{editorLabel(name)}</span>
          {name === editor && <Icon name="check" size={13} className="open-in-check" />}
        </button>
      ))}
    </div>
  );

  if (primaryAction) {
    return (
      <div className={`open-in-menu open-in-split ${className}`.trim()}>
        <button
          type="button"
          className="open-in-trigger open-in-primary"
          title={label}
          aria-label={label}
          onClick={primaryAction}
        >
          <EditorIcon editor={editor} size={16} />
          <span>{label}</span>
        </button>
        <details className="open-in-dropdown" ref={detailsRef}>
          <summary
            className="open-in-trigger open-in-caret"
            title={`${label} options`}
            aria-label={`${label} options`}
          >
            <Icon name="chevron-down" size={12} />
          </summary>
          {popover}
        </details>
      </div>
    );
  }

  return (
    <details className={`open-in-menu ${className}`.trim()} ref={detailsRef}>
      <summary className="open-in-trigger" title={label}>
        <EditorIcon editor={editor} size={16} />
        <span>{label}</span>
        <Icon name="chevron-down" size={12} />
      </summary>
      {popover}
    </details>
  );
}
