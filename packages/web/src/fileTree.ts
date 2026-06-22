import type { DiffFile, FileStatus } from "@diffect/shared";

export type TreeFileStatus = FileStatus | "unchanged";

/**
 * DOM id of a file's diff block, repo-qualified so stacked modules (one diff list
 * per repo, sharing a scroll container) never collide on a shared path. The
 * scroll-spy reads the file path back off the element's `data-path` attribute
 * rather than parsing this id, since both `repo` and `path` may contain hyphens.
 */
export function fileElementId(repo: string, path: string): string {
  return `file-${repo}-${path}`;
}

export interface FileTreeEntry {
  path: string;
  status: TreeFileStatus;
  file?: DiffFile;
}

export interface TreeFile {
  type: "file";
  name: string;
  path: string;
  status: TreeFileStatus;
  file?: DiffFile;
}
export interface TreeDir {
  type: "dir";
  /** Display name, possibly a collapsed chain like "src/components". */
  name: string;
  /** Full path of the deepest directory in the (possibly collapsed) chain. */
  path: string;
  children: TreeNode[];
}
export type TreeNode = TreeFile | TreeDir;

/**
 * Build a directory tree from a flat list of changed files, then collapse
 * single-child folder chains (`src` → `src/app` → `src/app/x` becomes one
 * `src/app/x` row) and sort folders-first, alphabetically — the GitHub/VS Code
 * file-tree convention.
 */
export function buildFileTree(files: DiffFile[]): TreeNode[] {
  return buildPathTree(
    files.map((file) => ({ path: file.path, status: file.status, file })),
  );
}

export function buildPathTree(entries: FileTreeEntry[]): TreeNode[] {
  const root: TreeDir = { type: "dir", name: "", path: "", children: [] };
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      const childPath = dir.path ? `${dir.path}/${seg}` : seg;
      let next = dir.children.find(
        (c): c is TreeDir => c.type === "dir" && c.name === seg,
      );
      if (!next) {
        next = { type: "dir", name: seg, path: childPath, children: [] };
        dir.children.push(next);
      }
      dir = next;
    }
    dir.children.push({
      type: "file",
      name: parts[parts.length - 1]!,
      path: entry.path,
      status: entry.status,
      file: entry.file,
    });
  }
  return finalize(root.children);
}

/**
 * The changed files in tree display order (folders-first, alphabetical, chains
 * collapsed) so the main diff list reads top-to-bottom exactly like the sidebar
 * tree — scrolling the diff then walks the tree in order instead of jumping.
 */
export function orderedDiffFiles(files: DiffFile[]): DiffFile[] {
  const out: DiffFile[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.type === "file" && n.file) out.push(n.file);
      else if (n.type === "dir") walk(n.children);
    }
  };
  walk(buildFileTree(files));
  return out;
}

function finalize(nodes: TreeNode[]): TreeNode[] {
  return sortNodes(
    nodes.map((node) => {
      if (node.type !== "dir") return node;
      let dir = node;
      // Fold a chain of single-subdirectory folders into one row.
      while (dir.children.length === 1 && dir.children[0]!.type === "dir") {
        const only = dir.children[0] as TreeDir;
        dir = {
          type: "dir",
          name: `${dir.name}/${only.name}`,
          path: only.path,
          children: only.children,
        };
      }
      return { ...dir, children: finalize(dir.children) };
    }),
  );
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
