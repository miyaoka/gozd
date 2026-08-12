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

// --- main → renderer push payload ---

/** gozdOpen push payload。CLI `gozd <path>` / 起動要求ファイルの消費で renderer に届く。 */
export interface GozdOpenPayload {
  dir: string;
  /**
   * main 側 `openTarget.ts` の resolver は **ファイル指定のときだけ** selection を埋め、
   * その場合 `kind: "file"` 固定で送る（dir 指定時は selection 未指定）。renderer は
   * `kind` で分岐せず常に worktree 相対のファイルとして扱う契約。field を残すのは将来
   * `dir` 種別を追加する余地のため。判定 / mapping を増やすときは本コメントと
   * `openTarget.ts` の selection 生成箇所（`kind: "file"` リテラルを含むブロック）
   * を同時に更新する。
   */
  selection?: { kind: "file"; relPath: string; lineNumber: number };
  channel: string;
  repoName: string;
  isGitRepo: boolean;
  switchToDir: string;
  /**
   * native 側で git バイナリの解決自体に失敗した場合（`GitError.launchFailed`）に積まれる。
   * `commandFailed`（probeDir が git 管理外 / detached HEAD 等）は積まず、`isGitRepo = false`
   * として既存挙動を維持する。両者を区別することで、ユーザーシェル経由でも git を解決できない
   * 病的環境を「git repo ではない」と silent に化けさせず notify.error で可視化する。
   */
  error?: string;
}
