import type { GitFileChange } from "@gozd/proto";

export type ChangesTreeNode =
  | {
      kind: "folder";
      /**
       * chain 圧縮されたセグメント列。表示は join("/")、folder アイコン解決は最深要素を使う。
       * displayName / leafName を別フィールドにすると更新漏れが起きるため SSOT としてここに集約する。
       */
      displaySegments: string[];
      /**
       * 折りたたみ・key 用の anchor。chain 圧縮の **最浅** segment の fullPath を使う。
       * fileChanges の増減で chain 境界が伸縮しても anchor が動かないため、
       * ユーザーが畳んだ状態を保てる。
       */
      anchorPath: string;
      /**
       * chain 圧縮の **最深** folder の fullPath。user が UI 上で見ている folder 行は
       * この path を指す (例: `.github/workflows` 表示なら `.github/workflows`)。
       * 右クリック menu で「この folder の path を copy」する経路で使う。
       */
      displayPath: string;
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

/**
 * ツリーを depth-first に走査して、ChangesPane の描画順と同じ並びの GitFileChange 配列を返す。
 *
 * ChangesSummaryView (View all) が「ツリーで見える順に縦積み」したいときに使う。ソート規律
 * (フォルダ先 + 各群を localeCompare、chain 圧縮込み) は `buildChangesTree` に閉じているため、
 * 本関数はそれを再現せずツリー自体を走査することで SSOT を保つ。
 *
 * 入力は `ChangesTreeNode[]` (= 構造) のみ。ChangesPane の `collapsedFolders` のような描画状態は
 * 受け取らないため、結果は collapsed 状態に依存せず常に全件展開された順序になる。
 */
export function flattenChangesTree(tree: readonly ChangesTreeNode[]): GitFileChange[] {
  const out: GitFileChange[] = [];
  const visit = (nodes: readonly ChangesTreeNode[]) => {
    for (const node of nodes) {
      if (node.kind === "folder") {
        visit(node.children);
      } else {
        out.push(node.change);
      }
    }
  };
  visit(tree);
  return out;
}

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
  // 末尾 `/` や 空 segment（`a//b`）は git 出力としてあり得ない不変条件。
  // silently 落とすと「changes に出るはずのファイルが UI に出ない」観察不能事象になるため throw する
  if (segments.some((s) => s === "")) {
    throw new Error(`Invalid file path: ${JSON.stringify(change.newFilePath)}`);
  }
  const fileName = segments.at(-1);
  if (fileName === undefined) {
    throw new Error(`Empty file path in change`);
  }
  const dirs = segments.slice(0, -1);

  let current = root;
  for (const segment of dirs) {
    const existing = current.childMap.get(segment);
    if (existing !== undefined) {
      if (existing.kind !== "folder") {
        throw new Error(
          `Path collision: file and folder share the name ${JSON.stringify(segment)}`,
        );
      }
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
  if (current.childMap.has(fileName)) {
    throw new Error(`Duplicate change for path: ${JSON.stringify(change.newFilePath)}`);
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
  const displaySegments = [raw.name];
  // 子が単一フォルダのみの場合、その子と連結する（GitHub 風 chain 圧縮）
  while (current.childMap.size === 1) {
    const [onlyChild] = current.childMap.values();
    if (onlyChild === undefined || onlyChild.kind !== "folder") break;
    displaySegments.push(onlyChild.name);
    current = onlyChild;
  }
  return {
    kind: "folder",
    displaySegments,
    anchorPath: raw.fullPath,
    displayPath: current.fullPath,
    children: finalizeChildren(current),
  };
}

function compareName(a: ChangesTreeNode, b: ChangesTreeNode): number {
  const aName = a.kind === "folder" ? a.displaySegments.join("/") : a.name;
  const bName = b.kind === "folder" ? b.displaySegments.join("/") : b.name;
  return aName.localeCompare(bName);
}
