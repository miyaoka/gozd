import type { GitFileChange } from "@gozd/proto";

export type ChangesTreeNode =
  | {
      kind: "folder";
      /** ディレクトリ表示名。chain 圧縮時は "a/b/c" 形式 */
      displayName: string;
      /** ルートからのフルパス（chain 圧縮の最深 segment まで） */
      fullPath: string;
      children: ChangesTreeNode[];
    }
  | {
      kind: "file";
      name: string;
      change: GitFileChange;
    };

type RawFolder = {
  kind: "folder";
  name: string;
  fullPath: string;
  childMap: Map<string, RawFolder | RawFile>;
};
type RawFile = {
  kind: "file";
  name: string;
  change: GitFileChange;
};

/** GitFileChange[] から表示用ツリーを組み立てる。子が単一フォルダのみのフォルダは親と連結する。 */
export function buildChangesTree(changes: readonly GitFileChange[]): ChangesTreeNode[] {
  const root: RawFolder = { kind: "folder", name: "", fullPath: "", childMap: new Map() };

  for (const change of changes) {
    insertChange(root, change);
  }

  return finalizeChildren(root);
}

function insertChange(root: RawFolder, change: GitFileChange) {
  const segments = change.newFilePath.split("/");
  const fileName = segments.pop();
  if (fileName === undefined || fileName === "") return;

  let current = root;
  for (const segment of segments) {
    const existing = current.childMap.get(segment);
    if (existing && existing.kind === "folder") {
      current = existing;
      continue;
    }
    const fullPath = current.fullPath === "" ? segment : `${current.fullPath}/${segment}`;
    const folder: RawFolder = {
      kind: "folder",
      name: segment,
      fullPath,
      childMap: new Map(),
    };
    current.childMap.set(segment, folder);
    current = folder;
  }
  current.childMap.set(fileName, { kind: "file", name: fileName, change });
}

function finalizeChildren(folder: RawFolder): ChangesTreeNode[] {
  const folders: ChangesTreeNode[] = [];
  const files: ChangesTreeNode[] = [];
  for (const child of folder.childMap.values()) {
    if (child.kind === "folder") {
      folders.push(collapseFolder(child));
    } else {
      files.push({ kind: "file", name: child.name, change: child.change });
    }
  }
  folders.sort((a, b) => compareName(a, b));
  files.sort((a, b) => compareName(a, b));
  return [...folders, ...files];
}

function collapseFolder(raw: RawFolder): ChangesTreeNode {
  let current = raw;
  let displayName = raw.name;
  // 子が単一フォルダのみの場合、その子と連結する（GitHub 風 chain 圧縮）
  while (current.childMap.size === 1) {
    const [onlyChild] = current.childMap.values();
    if (onlyChild === undefined || onlyChild.kind !== "folder") break;
    displayName = `${displayName}/${onlyChild.name}`;
    current = onlyChild;
  }
  return {
    kind: "folder",
    displayName,
    fullPath: current.fullPath,
    children: finalizeChildren(current),
  };
}

function compareName(a: ChangesTreeNode, b: ChangesTreeNode): number {
  const aName = a.kind === "folder" ? a.displayName : a.name;
  const bName = b.kind === "folder" ? b.displayName : b.name;
  return aName.localeCompare(bName);
}
