// `git status --porcelain=v2 -z` 相当のファイル状態を取得する。
//
// issue #310 の方針: 全 RPC は明示的に `dir` を受け取り、
// main 側で `currentDir` を持たないステートレス API として動作する。

import type { UpstreamStatus } from "./common";

export interface GitStatusRequest {
  /** 対象 worktree の絶対パス。 */
  dir: string;
}

export interface GitStatusResponse {
  /** ファイル相対パス → porcelain v2 の XY ステータスコード（例: ".M", "??", "M.", "R."）。
   * 値は常に長さ 2 の文字列。1 文字目 = index 状態、2 文字目 = working tree 状態。
   * 未変更側は "."（v1 の " " と異なる）。 */
  entries: Record<string, string>;
  /** upstream に対する差分。未設定なら不在。 */
  upstream?: UpstreamStatus;
  /** 変更ファイルの最終更新時刻 (Unix 秒)。`entries` の各パスを stat した最大値。
   * clean (差分なし) / stat 全失敗のときは 0。削除済みパスは stat 失敗で自動除外。 */
  latestMtime: number;
  /** rename / copy エントリの 新パス → 旧パス。`entries` のキーは新パスのみ持つため、
   * 旧パス (HEAD 側の比較元) はこの map で運ぶ。rename が無ければ空。 */
  renameOldPaths: Record<string, string>;
}
