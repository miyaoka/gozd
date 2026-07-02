import type { GitChangeKind } from "../worktree";

export type PreviewMode = "current" | "diff" | "original";

/** diff がある変更種別か */
export function hasGitDiff(gitChange: GitChangeKind | undefined): boolean {
  if (gitChange === undefined) return false;
  return gitChange !== "untracked";
}

/** デフォルトモードの決定 */
export function defaultMode(gitChange: GitChangeKind | undefined): PreviewMode {
  if (gitChange === "deleted") return "original";
  if (hasGitDiff(gitChange)) return "diff";
  return "current";
}

/** 選択ファイルの変更状態に応じて利用可能なモード一覧を返す */
export function availableModesFor(
  gitChange: GitChangeKind | undefined,
  isImagePreview: boolean,
): PreviewMode[] {
  if (gitChange === "deleted") return ["original"];
  if (hasGitDiff(gitChange)) {
    // 画像プレビュー中は diff モードを除外
    if (isImagePreview) return ["original", "current"];
    return ["original", "diff", "current"];
  }
  return ["current"];
}
