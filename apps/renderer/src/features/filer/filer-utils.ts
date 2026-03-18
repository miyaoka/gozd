interface FileEntry {
  name: string;
  isDirectory: boolean;
  isIgnored: boolean;
  /** git の変更種別（undefined = 変更なし） */
  gitChange?: GitChangeKind;
}

/**
 * git status --porcelain=v1 のステータスコード（2文字）から変更種別を判定する。
 * X（index）と Y（worktree）のうち、より目立つ方を優先する。
 */
type GitChangeKind = "modified" | "added" | "deleted" | "untracked" | "renamed";

const GIT_STATUS_KIND_MAP: Record<string, GitChangeKind> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "renamed",
};

function resolveGitChangeKind(statusCode: string): GitChangeKind {
  if (statusCode === "??") return "untracked";
  // worktree 側 (Y) を優先、なければ index 側 (X) を使う
  const worktree = statusCode[1];
  const index = statusCode[0];
  if (worktree !== undefined && worktree !== " ") {
    return GIT_STATUS_KIND_MAP[worktree] ?? "modified";
  }
  if (index !== undefined && index !== " ") {
    return GIT_STATUS_KIND_MAP[index] ?? "modified";
  }
  return "modified";
}

/**
 * ファイルパスの git 変更種別を解決する。
 * 直接マッチしない場合、untracked ディレクトリ（末尾 / 付き）の配下かどうかも確認する。
 */
function resolveFileGitChange(
  filePath: string,
  gitStatuses: Record<string, string>,
): GitChangeKind | undefined {
  const statusCode = gitStatuses[filePath];
  if (statusCode) return resolveGitChangeKind(statusCode);
  // untracked ディレクトリの配下ファイル: git status は "dir/" のみ出力し中身は列挙しない
  for (const [path, code] of Object.entries(gitStatuses)) {
    if (code !== "??" || !path.endsWith("/")) continue;
    if (filePath.startsWith(path)) return "untracked";
  }
  return undefined;
}

/**
 * git status マップからディレクトリの変更種別を推論する。
 * 配下の変更種別が1種類ならその種別を返し、複数種別が混在する場合は modified を返す。
 */
function resolveDirectoryGitChange(
  dirPath: string,
  gitStatuses: Record<string, string>,
): GitChangeKind | undefined {
  const prefix = dirPath === "" ? "" : dirPath + "/";
  let found: GitChangeKind | undefined;

  for (const [filePath, statusCode] of Object.entries(gitStatuses)) {
    if (!filePath.startsWith(prefix)) continue;
    const kind = resolveGitChangeKind(statusCode);
    if (found === undefined) {
      found = kind;
    } else if (found !== kind) {
      return "modified";
    }
  }
  return found;
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

/**
 * パス中の `.` と `..` を解決し、連続スラッシュ・末尾スラッシュを除去する。
 * 絶対パスではルートを越える `..` を無視し、相対パスでは先頭の `..` を保持する。
 */
function normalizePath(path: string): string {
  const isAbsolute = path.startsWith("/");
  const isTilde = path.startsWith("~/");

  const segments = path.split("/").filter((s) => s !== "");
  const result: string[] = [];

  // ~ プレフィックスはセグメントから除外して後で復元する
  const startIdx = isTilde ? 1 : 0;

  for (let i = startIdx; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg === ".") continue;
    if (seg === "..") {
      if (result.length > 0 && result[result.length - 1] !== "..") {
        result.pop();
      } else if (!isAbsolute && !isTilde) {
        // 相対パスでは先頭の .. を保持
        result.push("..");
      }
      continue;
    }
    result.push(seg);
  }

  const joined = result.join("/");
  if (isTilde) return `~/${joined}`;
  if (isAbsolute) return `/${joined}`;
  return joined;
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

export {
  dirName,
  getDeletedEntries,
  normalizePath,
  resolveDirectoryGitChange,
  resolveFileGitChange,
  resolveGitChangeKind,
  sortEntries,
};
export type { FileEntry, GitChangeKind };
