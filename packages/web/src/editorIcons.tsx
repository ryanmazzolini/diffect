import clionIcon from "./assets/editors/clion.svg";
import datagripIcon from "./assets/editors/datagrip.svg";
import golandIcon from "./assets/editors/goland.svg";
import intellijIdeaIcon from "./assets/editors/intellij-idea.svg";
import phpstormIcon from "./assets/editors/phpstorm.svg";
import pycharmIcon from "./assets/editors/pycharm.svg";
import riderIcon from "./assets/editors/rider.svg";
import rubymineIcon from "./assets/editors/rubymine.svg";
import vscodeIcon from "./assets/editors/vscode.svg";
import webstormIcon from "./assets/editors/webstorm.svg";

// Editor/product icons are vendored so the app has no runtime icon CDN or
// icon-package dependency. See docs/third-party-assets.md for attribution.
const IMAGE_ICONS: Record<string, string> = {
  code: vscodeIcon,
  idea: intellijIdeaIcon,
  webstorm: webstormIcon,
  pycharm: pycharmIcon,
  goland: golandIcon,
  clion: clionIcon,
  phpstorm: phpstormIcon,
  rubymine: rubymineIcon,
  rider: riderIcon,
  datagrip: datagripIcon,
};

const ICONS = {
  cursor: {
    viewBox: "0 0 24 24",
    path: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
  },
  zed: {
    viewBox: "0 0 24 24",
    path: "M2.25 1.5a.75.75 0 0 0-.75.75v16.5H0V2.25A2.25 2.25 0 0 1 2.25 0h20.095c1.002 0 1.504 1.212.795 1.92L10.764 14.298h3.486V12.75h1.5v1.922a1.125 1.125 0 0 1-1.125 1.125H9.264l-2.578 2.578h11.689V9h1.5v9.375a1.5 1.5 0 0 1-1.5 1.5H5.185L2.562 22.5H21.75a.75.75 0 0 0 .75-.75V5.25H24v16.5A2.25 2.25 0 0 1 21.75 24H1.655C.653 24 .151 22.788.86 22.08L13.19 9.75H9.75v1.5h-1.5V9.375A1.125 1.125 0 0 1 9.375 8.25h5.314l2.625-2.625H5.625V15h-1.5V5.625a1.5 1.5 0 0 1 1.5-1.5h13.19L21.438 1.5z",
  },
};

type IconKey = keyof typeof ICONS;

function iconKey(editor: string): IconKey | null {
  if (editor === "cursor") return "cursor";
  if (editor === "zed") return "zed";
  return null;
}

interface EditorIconProps {
  editor: string;
  size?: number;
  className?: string;
}

export function EditorIcon({ editor, size = 16, className = "" }: EditorIconProps) {
  const imageIcon = IMAGE_ICONS[editor];
  if (imageIcon) {
    return (
      <img
        src={imageIcon}
        alt=""
        aria-hidden="true"
        className={`editor-icon editor-icon-img ${className}`.trim()}
        style={{ width: size, height: size }}
      />
    );
  }

  const key = iconKey(editor);
  if (!key) return <EditorFallbackIcon editor={editor} size={size} className={className} />;
  const icon = ICONS[key];
  return (
    <svg
      width={size}
      height={size}
      viewBox={icon.viewBox}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={`editor-icon editor-icon-${key} ${className}`.trim()}
    >
      <path d={icon.path} />
    </svg>
  );
}

function EditorFallbackIcon({
  editor,
  size,
  className = "",
}: {
  editor: string;
  size: number;
  className?: string;
}) {
  return (
    <span
      className={`editor-icon editor-icon-fallback ${className}`.trim()}
      aria-hidden="true"
      style={{ width: size, height: size }}
    >
      {editor.slice(0, 2).toUpperCase()}
    </span>
  );
}
