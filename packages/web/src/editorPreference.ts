import { getStored, setStored } from "./storage.js";

const EDITOR_KEY = "diffect-preferred-editor";
const LABELS: Record<string, string> = {
  code: "VS Code",
  cursor: "Cursor",
  zed: "Zed",
  idea: "IntelliJ IDEA",
  webstorm: "WebStorm",
  pycharm: "PyCharm",
  goland: "GoLand",
  clion: "CLion",
  phpstorm: "PhpStorm",
  rubymine: "RubyMine",
  rider: "Rider",
  datagrip: "DataGrip",
};

export function editorLabel(editor: string): string {
  return LABELS[editor] ?? editor;
}

export function loadPreferredEditor(): string | null {
  return getStored(EDITOR_KEY);
}

export function savePreferredEditor(editor: string): void {
  setStored(EDITOR_KEY, editor);
}

export function pickEditor(editors: string[], preferred: string | null): string | null {
  if (preferred && editors.includes(preferred)) return preferred;
  return editors[0] ?? null;
}
