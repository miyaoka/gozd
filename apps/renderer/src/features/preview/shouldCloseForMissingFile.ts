import type { Selection } from "../worktree";

/**
 * 表示中ファイルが消えたとき preview を閉じる (選択解除する) べきか判定する純粋関数。
 *
 * 「閉じる」= current (作業ツリー) にも HEAD にも内容が無い (= 未追跡ファイルの削除等で実体が
 * どこにも残っていない)。git 追跡下の削除は HEAD に内容が残り Original を閲覧できるため
 * `originalMissing=false` となり閉じない。
 *
 * 早期 return:
 * - summary view 表示中は単一ファイル選択の概念が無いため閉じない (summary を巻き込まない)
 * - worktree 外の絶対パスは git 履歴を持たず本判定の対象外 (閉じない)
 * - current が notFound でない (ファイルが在る) なら閉じない
 */
export function shouldCloseForMissingFile(args: {
  summaryEnabled: boolean;
  selKind: Selection["kind"];
  currentNotFound: boolean;
  originalMissing: boolean;
}): boolean {
  const { summaryEnabled, selKind, currentNotFound, originalMissing } = args;
  if (summaryEnabled) return false;
  if (selKind !== "worktreeRelative") return false;
  if (!currentNotFound) return false;
  return originalMissing;
}
