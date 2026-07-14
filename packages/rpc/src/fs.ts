// ファイルシステム RPC の型。
//
// path は dir からの相対パス。dir 範囲外への path traversal は main 実装側で
// 拒否する（issue #310 のステートレス + sandboxing 方針）。

import type { EmptyMessage, FileReadResult } from "./common";

export interface FsReadFileRequest {
  dir: string;
  path: string;
}

/** content はテキストなら string、バイナリなら生 bytes（FileReadResult の契約）。
 * ディレクトリなら isDirectory=true、ファイル不在なら notFound=true。 */
export type FsReadFileResponse = FileReadResult;

// ディレクトリエントリ列挙。
//
// type は "file" / "directory" / "symlink" / "other" の文字列。renderer 側の
// リテラル判定をそのまま書けるよう enum 化しない。
export interface FsReadDirRequest {
  dir: string;
  path: string;
}

export interface FsReadDirEntry {
  name: string;
  type: string;
  /** gitignore で無視されているか。dir が git repo でない場合は常に false。 */
  isIgnored: boolean;
}

export interface FsReadDirResponse {
  entries: FsReadDirEntry[];
  /** ディレクトリが存在しない（削除済み等）場合 true。読み取りエラー（permission 等）は
   * throw してエラーにするが、不在は期待状態として正常応答で返す（FsReadFileResponse の
   * notFound と同じ規律）。renderer は削除ノードとして扱い、エラートーストを出さない。 */
  notFound: boolean;
}

/** ディレクトリ配下の変更監視を開始する。
 * 重複 watch（同 dir）は no-op。FSWatchRegistry が dir をキーに 1 watcher を保持する。 */
export interface FsWatchRequest {
  dir: string;
}

export type FsWatchResponse = EmptyMessage;

/** 監視を停止する。watch されていない dir でも no-op で成功する。 */
export interface FsUnwatchRequest {
  dir: string;
}

export type FsUnwatchResponse = EmptyMessage;

/** 全 watch を一括停止する。renderer の onUnmounted で N 個の `/fs/unwatch` を
 * 並列発射する代わりに 1 回の RPC で済ませる。main 側 entry は idempotent に
 * 破棄され、残骸を残さない（FSEventStream slot leak の構造防止）。 */
export type FsUnwatchAllRequest = EmptyMessage;

/** 観察可能性のため、解除した dir 数を返す。renderer の watchedDirs と差異が
 * 出れば前段で race が発生していた示唆になる。 */
export interface FsUnwatchAllResponse {
  unwatchedCount: number;
}

/** 絶対パスでのファイル読み取り（dir 外を許可）。プレビュー等で使用。
 * path traversal の責任は呼び出し側に移譲する。 */
export interface FsReadFileAbsoluteRequest {
  absolutePath: string;
}
export interface FsReadFileAbsoluteResponse {
  result: FileReadResult;
}

/** fsWriteFile: dir 配下に書き込む。path traversal guard は main 側。
 * content は UTF-8 テキスト（書き込み経路は preview の編集保存のみで、バイナリ書き込みは
 * 存在しない。旧ワイヤの base64 bytes は proto 廃止時にテキスト直送へ置き換えた）。 */
export interface FsWriteFileRequest {
  dir: string;
  path: string;
  content: string;
}
export type FsWriteFileResponse = EmptyMessage;

/** fsStat: ファイル / ディレクトリの存在確認 + 種別取得 */
export interface FsStatRequest {
  dir: string;
  path: string;
}
export interface FsStatResponse {
  exists: boolean;
  /** "file" / "directory" / "symlink" */
  type: string;
  size: number;
  /** ISO 8601 */
  modifiedAt: string;
}
