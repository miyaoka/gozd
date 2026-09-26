/** repo アイコンの表示サイズ。sm は行の中に添える用途で、md の半分 */
export type RepoIconSize = "md" | "sm";

export const REPO_ICON_SIZE_CLASS: Record<RepoIconSize, { box: string; rounded: string }> = {
  md: { box: "size-6", rounded: "rounded-md" },
  sm: { box: "size-3", rounded: "rounded-xs" },
};
