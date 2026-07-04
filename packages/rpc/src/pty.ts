// PTY 操作 RPC の型。
//
// push イベント（ptyText / ptyExit）の payload 型は renderer の terminal feature が
// 手書きで定義する（shared/rpc の messages.ts 設計判断を参照）。

import type { EmptyMessage } from "./common";

/** PTY 子プロセスを spawn して PTY master fd を確立する。
 * 戻り値 ptyId は同一アプリセッション内で有効な不透明 ID。 */
export interface PtySpawnRequest {
  dir: string;
  executable: string;
  /** ワイヤ契約: argv **全体**（args[0] = プログラム名）。node-pty は spawn(file, args) の
   * args に argv[0] を含めない流儀のため、main 側で args.slice(1) して渡す。 */
  args: string[];
  env: Record<string, string>;
  rows: number;
  cols: number;
  /** この PTY が属する worktree の絶対パス。Claude セッション復元の紐付けに使う。
   * 空文字なら無紐付け。 */
  worktreePath: string;
}

export interface PtySpawnResponse {
  ptyId: number;
}

/** PTY master fd への書き込み（renderer → 子プロセスのキー入力等）。
 * data は xterm.js の onData が渡す UTF-8 テキストそのまま
 * （旧ワイヤの base64 bytes は proto 廃止時にテキスト直送へ置き換えた。
 * 入力の源泉が JS string なので encode/decode の往復は不要）。 */
export interface PtyWriteRequest {
  ptyId: number;
  data: string;
}

export type PtyWriteResponse = EmptyMessage;

/** terminal サイズの変更を子プロセスに通知（xterm.js のリサイズ連動）。 */
export interface PtyResizeRequest {
  ptyId: number;
  rows: number;
  cols: number;
}

export type PtyResizeResponse = EmptyMessage;

/** 子プロセスに SIGHUP を送る。 */
export interface PtyKillRequest {
  ptyId: number;
}

export type PtyKillResponse = EmptyMessage;
