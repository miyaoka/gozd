// PR / issue の種別を描くときの共通語彙。my-work の行アイコン・見出しリンク・失敗導線が
// 同じアイコンとラベルを使うため、マッピングをここに 1 つだけ置く。
import type { GitItemKind } from "@gozd/rpc";
import type { FunctionalComponent, SVGAttributes } from "vue";
import IconLucideCircleDot from "~icons/lucide/circle-dot";
import IconLucideGitPullRequest from "~icons/lucide/git-pull-request";

/** 種別 → アイコンと表示ラベル。ラベルは GitHub web の表記に合わせた複数形の自然語 */
export const ITEM_KIND_DISPLAY: Record<
  GitItemKind,
  { icon: FunctionalComponent<SVGAttributes>; label: string }
> = {
  pr: { icon: IconLucideGitPullRequest, label: "pull requests" },
  issue: { icon: IconLucideCircleDot, label: "issues" },
};
