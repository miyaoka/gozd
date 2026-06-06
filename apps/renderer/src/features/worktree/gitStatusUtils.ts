/**
 * git status --porcelain=v2 のステータスコード（XY の2文字）から変更種別を判定する。
 * X（index）と Y（worktree）のうち、より目立つ方を優先する。
 * v2 では未変更は "."（v1 では " "）。
 */
type GitChangeKind = "modified" | "added" | "deleted" | "untracked" | "renamed";

const GIT_STATUS_KIND_MAP: Record<string, GitChangeKind> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "renamed",
};

/** XY コードで「未変更」を表す文字か判定する（v2: "."） */
function isUnchanged(char: string | undefined): boolean {
  return char === " " || char === "." || char === undefined;
}

function resolveGitChangeKind(statusCode: string): GitChangeKind {
  if (statusCode === "??") return "untracked";
  // worktree 側 (Y) を優先、なければ index 側 (X) を使う
  const [index, worktree] = statusCode;
  if (!isUnchanged(worktree)) {
    return GIT_STATUS_KIND_MAP[worktree] ?? "modified";
  }
  if (!isUnchanged(index)) {
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

type GitStatusIconKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflict";

const STATUS_KIND_MAP: Record<string, GitStatusIconKind> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
};

/**
 * XY コードからファイル単位で1つの変更種別を解決する。
 * worktree 側 (Y) を優先し、なければ index 側 (X) を使う。
 */
function resolveStatusIconKind(status: string): GitStatusIconKind {
  if (status === "??") return "untracked";
  const [x, y] = status;
  // Unmerged: U in either position, or AA/DD (both-added / both-deleted)
  if (x === "U" || y === "U" || status === "AA" || status === "DD") return "conflict";
  if (!isUnchanged(y)) return STATUS_KIND_MAP[y] ?? "modified";
  if (!isUnchanged(x)) return STATUS_KIND_MAP[x] ?? "modified";
  return "modified";
}

/** ステータスアイコン定義 */
const STATUS_ICON_CONFIG: Record<GitStatusIconKind, { icon: string; color: string }> = {
  added: { icon: "icon-[lucide--file-plus]", color: "text-success" },
  modified: { icon: "icon-[lucide--file-diff]", color: "text-warning" },
  deleted: { icon: "icon-[lucide--file-x]", color: "text-destructive" },
  renamed: { icon: "icon-[lucide--file-input]", color: "text-info" },
  copied: { icon: "icon-[lucide--files]", color: "text-info" },
  untracked: { icon: "icon-[lucide--file-question-mark]", color: "text-success" },
  conflict: { icon: "icon-[lucide--file-exclamation-point]", color: "text-destructive" },
};

/** アイコンの表示順 */
const STATUS_ICON_ORDER: GitStatusIconKind[] = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "conflict",
];

interface StatusIconEntry {
  kind: GitStatusIconKind;
  icon: string;
  color: string;
  count: number;
}

/** カウントをアイコン付きエントリ配列に変換する */
function toStatusIconEntries(
  counts: Partial<Record<GitStatusIconKind, number>>,
): StatusIconEntry[] {
  const result: StatusIconEntry[] = [];
  for (const kind of STATUS_ICON_ORDER) {
    const count = counts[kind];
    if (count && count > 0) {
      const config = STATUS_ICON_CONFIG[kind];
      result.push({ kind, icon: config.icon, color: config.color, count });
    }
  }
  return result;
}

/** git status の生データからファイル単位で変更種別をカウントし、アイコン付きエントリを生成する */
function computeStatusIcons(statuses: Record<string, string>): StatusIconEntry[] {
  const counts: Partial<Record<GitStatusIconKind, number>> = {};
  for (const status of Object.values(statuses)) {
    const kind = resolveStatusIconKind(status);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return toStatusIconEntries(counts);
}

export {
  computeStatusIcons,
  resolveDirectoryGitChange,
  resolveFileGitChange,
  resolveGitChangeKind,
};
export type { GitChangeKind, StatusIconEntry };
