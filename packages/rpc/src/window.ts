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
