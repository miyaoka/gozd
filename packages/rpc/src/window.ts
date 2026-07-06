// gozd ウィンドウ操作 RPC。

import type { EmptyMessage } from "./common";

/** ウィンドウを閉じる（シングルウィンドウ運用ではアプリ終了相当）。 */
export type WindowCloseRequest = EmptyMessage;
export type WindowCloseResponse = EmptyMessage;

/** native window title（Mission Control / Cmd+Tab に出る文字列）の更新。
 * 表示整形（"repo · worktree"）は renderer のカスタムタイトルバーが SSOT で、
 * main は受け取った文字列をそのまま setTitle する。 */
export interface WindowSetTitleContextRequest {
  title: string;
}
export type WindowSetTitleContextResponse = EmptyMessage;

/** サーバー一覧パネルの開閉状態の通知。native toolbar 廃止後は受理のみ
 * （トグルボタンが renderer 内に移り、開閉ミラー自体が不要化。titlebar 対応時に再設計）。 */
export interface WindowSetServerPanelOpenRequest {
  open: boolean;
}
export type WindowSetServerPanelOpenResponse = EmptyMessage;
