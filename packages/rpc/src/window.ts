// gozd ウィンドウ操作 RPC。

import type { EmptyMessage } from "./common";

/** ウィンドウを閉じる（シングルウィンドウ運用ではアプリ終了相当）。 */
export type WindowCloseRequest = EmptyMessage;
export type WindowCloseResponse = EmptyMessage;

/** titlebar に出すコンテキスト（active repo / worktree）。
 * renderer 側で active worktree が変わるたびに push し、window title に反映する。 */
export interface WindowSetTitleContextRequest {
  repoName: string;
  worktreeName: string;
}
export type WindowSetTitleContextResponse = EmptyMessage;

/** サーバー一覧パネルの開閉状態の通知。native toolbar 廃止後は受理のみ
 * （トグルボタンが renderer 内に移り、開閉ミラー自体が不要化。titlebar 対応時に再設計）。 */
export interface WindowSetServerPanelOpenRequest {
  open: boolean;
}
export type WindowSetServerPanelOpenResponse = EmptyMessage;
