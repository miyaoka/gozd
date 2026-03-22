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

export { resolveDirectoryGitChange, resolveFileGitChange, resolveGitChangeKind };
export type { GitChangeKind };
