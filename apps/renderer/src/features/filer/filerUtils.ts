import type { GitChangeKind } from "../worktree";

interface FileEntry {
  name: string;
  isDirectory: boolean;
  isIgnored: boolean;
  /** git の変更種別（undefined = 変更なし） */
  gitChange?: GitChangeKind;
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

  return Array.from(deletedNames, ([name, isDirectory]) => ({
    name,
    isDirectory,
    isIgnored: false,
    gitChange: "deleted",
  }));
}

/** ディレクトリパスの末尾から表示名を抽出 */
function dirName(dirPath: string): string {
  const parts = dirPath.split("/");
  return parts[parts.length - 1] ?? dirPath;
}

/** ディレクトリ優先 → 名前順 */
function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

export { dirName, getDeletedEntries, sortEntries };
export type { FileEntry };
