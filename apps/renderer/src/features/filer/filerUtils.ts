import type { FsReadDirEntry, GitTreeEntry } from "@gozd/proto";
import type { GitChangeKind } from "../worktree";

/**
 * ファイラーノードの種類。`isDirectory: boolean` だけでは submodule / symlink が file 扱いに
 * 潰れてしまい、snapshot mode で submodule をクリックして `gitShowCommitFile` を呼ぶような
 * 経路差を構造的に区別できないため独立した SSOT として持つ。
 *
 * - `file` / `directory`: working / snapshot どちらでも表示・展開・選択の通常経路
 * - `symlink`: working tree では実 file へ resolve できるため select 可。snapshot tree では
 *   blob 内容が target path 文字列なので click を no-op に倒す (FileTreeItem 側で判定)
 * - `submodule`: gitlink object (`160000`)。git show <hash>:<path> では内容を返せないため
 *   常に no-op
 */
type FileEntryKind = "file" | "directory" | "symlink" | "submodule";

interface FileEntry {
  name: string;
  kind: FileEntryKind;
  /**
   * gitignore に該当するか。working tree mode 由来のみ意味があり、snapshot mode では
   * 概念自体が存在しないため undefined になる。`isIgnored === true` のときだけ "ignored" の
   * 視覚処理を入れる比較規約 (`=== true` 明示) を呼び出し側で守る。
   */
  isIgnored?: boolean;
  /** git の変更種別（undefined = 変更なし） */
  gitChange?: GitChangeKind;
}

/** FsReadDir 由来の type 文字列を FileEntryKind に写像する */
function fsTypeToKind(type: string): FileEntryKind {
  switch (type) {
    case "directory":
      return "directory";
    case "symlink":
      return "symlink";
    case "file":
      return "file";
    default:
      return "file";
  }
}

/** git ls-tree 由来の type 文字列を FileEntryKind に写像する */
function gitTreeTypeToKind(type: string): FileEntryKind {
  switch (type) {
    case "directory":
      return "directory";
    case "symlink":
      return "symlink";
    case "submodule":
      return "submodule";
    default:
      return "file";
  }
}

/**
 * git status の削除ファイルから、指定ディレクトリ直下の削除エントリを生成する。
 * ディスクには存在しないが、ツリーに表示するための仮想エントリ。
 */
function getDeletedEntries(dirPath: string, gitStatuses: Record<string, string>): FileEntry[] {
  const prefix = dirPath === "" ? "" : dirPath + "/";
  // 直下のファイル名 or ディレクトリ名（重複排除）
  const deletedNames = new Map<string, boolean>();

  for (const [filePath, statusCode] of Object.entries(gitStatuses)) {
    // D ステータスのみ対象（index 側 or worktree 側）
    const isDeleted = statusCode[0] === "D" || statusCode[1] === "D";
    if (!isDeleted) continue;
    if (!filePath.startsWith(prefix)) continue;

    const rest = filePath.slice(prefix.length);
    const slashIndex = rest.indexOf("/");
    if (slashIndex === -1) {
      // 直下のファイル
      deletedNames.set(rest, false);
    } else {
      // サブディレクトリ
      const dirName = rest.slice(0, slashIndex);
      if (!deletedNames.has(dirName)) {
        deletedNames.set(dirName, true);
      }
    }
  }

  return Array.from(deletedNames, ([name, isDir]) => ({
    name,
    kind: isDir ? "directory" : "file",
    gitChange: "deleted",
  }));
}

/** proto の FsReadDirEntry を FileEntry に変換する */
function toFileEntries(entries: FsReadDirEntry[]): FileEntry[] {
  return entries.map((e) => ({
    name: e.name,
    kind: fsTypeToKind(e.type),
    isIgnored: e.isIgnored,
  }));
}

/**
 * snapshot mode 用: `git ls-tree` の GitTreeEntry を FileEntry に変換する。
 * `isIgnored` は snapshot には概念が存在しないため undefined のまま (省略)。
 */
function toFileEntriesFromGitTree(entries: GitTreeEntry[]): FileEntry[] {
  return entries.map((e) => ({
    name: e.name,
    kind: gitTreeTypeToKind(e.type),
  }));
}

/** ディレクトリパスの末尾から表示名を抽出 */
function dirName(dirPath: string): string {
  const parts = dirPath.split("/");
  return parts[parts.length - 1] ?? dirPath;
}

/**
 * worktree 相対パスの親 + 子名を連結する。worktree 直下のパスを表現する `""` を
 * 親として渡すと先頭 `/` が付かない。`getDeletedEntries` の `prefix` 算出と同じ規律。
 */
function joinPath(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

/**
 * worktree 自体（不可視ルート）を表す path 値かどうか。main 側の `relDir` SSOT に合わせ、
 * worktree 直下を `""` で表現する規約に依存する全分岐の根拠を 1 か所に集約する。
 */
function isRootPath(path: string): boolean {
  return path === "";
}

/**
 * native の `URL(fileURLWithPath:)` は空文字を未定義扱いするため、worktree 直下を
 * RPC で指す時だけ `.` に置き換える。entries は dir からの相対で返るため、結果側の
 * パス組み立て（`joinPath`）は影響を受けない。
 */
function pathForNativeRpc(path: string): string {
  return isRootPath(path) ? "." : path;
}

/**
 * `targetPath` が `ancestorPath` の **厳密配下** にあるか判定する（自分自身は配下扱いではない）。
 * worktree ルート（`ancestorPath === ""`）はあらゆる非ルート relPath の祖先扱い。
 * root × root のケースは「祖先 != 自分自身」の規律に従って false を返す。
 */
function isDescendantOf(targetPath: string, ancestorPath: string): boolean {
  if (isRootPath(ancestorPath)) return !isRootPath(targetPath);
  return targetPath.startsWith(ancestorPath + "/");
}

/** ディレクトリ優先 → 名前順 */
function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.kind === "directory";
    const bDir = b.kind === "directory";
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export {
  dirName,
  getDeletedEntries,
  isDescendantOf,
  isRootPath,
  joinPath,
  pathForNativeRpc,
  sortEntries,
  toFileEntries,
  toFileEntriesFromGitTree,
};
export type { FileEntry, FileEntryKind };
