// 外部アプリ / ディレクトリ選択で「開く」系の RPC 型。

import type { EmptyMessage } from "./common";

/** 外部ブラウザ / 外部アプリで URL を開く。main 側で `shell.openExternal(url)`。
 * 用途: xterm.js のリンク Shift+クリックで OS ブラウザに飛ばす等。 */
export interface OpenExternalRequest {
  url: string;
}

export type OpenExternalResponse = EmptyMessage;

/** ローカルファイルを OS のデフォルトアプリで開く。main 側で
 * `shell.openPath(path)`（= macOS の `open` コマンド相当）。
 *
 * 用途: preview ペインのヘッダから表示中ファイルをデフォルトアプリで開く。
 * `openExternal` は scheme allowlist (http/https/mailto) で `file://` を弾く防壁を持つため、
 * ローカルファイルを開く intent は別 RPC として分離する。 */
export interface OpenFileRequest {
  /** 開く対象の絶対パス。相対→絶対の解決は基準ディレクトリ (worktree root) を持つ renderer の
   * 責務であり、ここには常に解決済みの絶対パスが渡る契約。main は基準ディレクトリを持たず
   * 解決 (再実装) はしない。非絶対入力が CWD 基準で silent に絶対化される暗黙 fallback を
   * 塞ぐため、入口で非絶対 (空文字含む) を invalid として弾く。 */
  path: string;
}

export type OpenFileResponse = EmptyMessage;

/** ネイティブのディレクトリ選択ダイアログを開いてユーザーに dir を選ばせる。
 * 選択後、内部で openTarget callback を呼んで gozdOpen を push する。
 * ユーザーがキャンセルした場合は何もしない。
 * 用途: サイドバーの「Add directory」ボタン。 */
export type PickAndOpenRequest = EmptyMessage;
export type PickAndOpenResponse = EmptyMessage;
