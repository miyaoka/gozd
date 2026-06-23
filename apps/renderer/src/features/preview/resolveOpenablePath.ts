import type { GitChangeKind, Selection } from "../worktree";
import { joinAbsRel } from "../worktree";

/**
 * 表示中ファイルを OS のデフォルトアプリで開くための実 (working tree) 絶対パスを解決する純粋関数。
 * 開けない (working tree に実体が無い) ケースは undefined を返し、呼び出し側はボタン描画自体を
 * gate する。これにより「押せるが native の存在チェックで必ず失敗する」silent dead button
 * (DiffPreview docstring 規約 / `blameEnabled` と同じ規律) を構造的に作らない。
 *
 * 表示用の `selectedDisplayPath` は RPC 入力に使わない契約のため流用せず、selection の kind から
 * 実パスを組む。commit / PR diff モードでも対象は常に working tree の実ファイル (git 履歴の内容
 * ではない)。
 *
 * undefined を返す条件:
 * - selection 無し (プレビュー未選択)
 * - `isNotFound` (working tree から read できなかった = 実体が無い)。絶対パス選択の削除もここで拾う
 * - `effectiveGitChange === "deleted"` (commit / PR diff モードで削除済み版を表示中、working tree に実体無し)
 * - worktreeRelative なのに dir 未確立
 */
export function resolveOpenablePath(args: {
  selection: Selection | undefined;
  dir: string | undefined;
  isNotFound: boolean;
  effectiveGitChange: GitChangeKind | undefined;
}): string | undefined {
  const { selection, dir, isNotFound, effectiveGitChange } = args;
  if (selection === undefined) return undefined;
  if (isNotFound) return undefined;
  if (effectiveGitChange === "deleted") return undefined;
  if (selection.kind === "absolute") return selection.absPath;
  if (dir === undefined) return undefined;
  return joinAbsRel(dir, selection.relPath);
}
