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

/** undock child window の位置更新（ドラッグ追従）。renderer の `moveTo` は Blink が
 * キャッシュした高さ込みの full rect を SetBounds に送るため、resize と並走するドラッグで
 * 高さを破壊する。main の setPosition は位置のみ書くため、移動はこの RPC 経由で行う。 */
export interface ChildWindowMoveRequest {
  /** 対象 child window の frame 名（main 側 registry のキー）。 */
  frameName: string;
  /** 外枠原点のスクリーン座標。 */
  x: number;
  y: number;
}
export type ChildWindowMoveResponse = EmptyMessage;

/** undock child window の高さ加算（mount 後に実測したヘッダ高の反映）。renderer の
 * `resizeBy` は Blink キャッシュ基準で実 bounds とずれるため、main が実 bounds を読んで
 * 加算する。 */
export interface ChildWindowResizeByRequest {
  frameName: string;
  deltaHeight: number;
}
export type ChildWindowResizeByResponse = EmptyMessage;
