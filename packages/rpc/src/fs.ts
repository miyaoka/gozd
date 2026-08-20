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
export interface FsReadDirRequest {
  dir: string;
  path: string;
}

/** entry の実体の在り処。entry 自身の情報（name / type）と実体の情報を分けて持つことで、
 * renderer は「symlink であること」と「実体としてどう振る舞うか」を独立に決められる。 */
export interface FsReadDirRealTarget {
  /** 実体の種別。symlink chain を辿った先なので symlink は現れない */
  type: "file" | "directory";
  /** 実体の絶対パス（realpath。chain 全体を解決済み） */
  absPath: string;
  /** 実体が readDir の `dir` 配下にある場合の dir 相対パス。dir 外を指すなら未設定。
   * 判定は realpath 同士で行うため、dir 自身が symlink 経由のパスでも取り違えない。 */
  relPath?: string;
}

export interface FsReadDirEntry {
  name: string;
  /** entry 自身の種別。lstat 由来（link は辿らず "symlink"）だが、`submodule` だけは
   * lstat では判別できないため index の gitlink（mode `160000`）を突き合わせて決める。
   * 未初期化の submodule は working tree 上ただの空ディレクトリで、ディスク側に手がかりが
   * 一切無い（初期化済みかどうかで種別が変わらないよう git を SSOT に置く）。 */
  type: "file" | "directory" | "symlink" | "submodule";
  /** submodule が指す commit hash（index の gitlink object）。`type === "submodule"` のときだけ設定。 */
  submoduleHash?: string;
  /** 実体の在り処が entry のパス（`dir` + `path` + `name`）と食い違うときだけ設定する。
   * 該当するのは symlink 自身と、symlink 越しに列挙された entry（親 dir が link）の 2 経路。
   * 辿れない link（dangling / 循環 / 中間成分が非ディレクトリ）は未設定で「実体なし」を表す。 */
  realTarget?: FsReadDirRealTarget;
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

/** 絶対パスへの書き込み（dir 外を許可）。fsReadFileAbsolute の書き込み対。preview の
 * worktree 外ファイル（設定 JSON 等）の編集保存で使用。絶対パス以外は main 側で reject する
 * （相対パスが CWD 基準で silent に解決される Foundation/Node の暗黙 fallback を塞ぐ）。 */
export interface FsWriteFileAbsoluteRequest {
  absolutePath: string;
  content: string;
}
export type FsWriteFileAbsoluteResponse = EmptyMessage;

/** 絶対パスの単一ファイル監視を開始する（dir 外を許可）。preview が表示中の worktree 外
 * ファイル（設定 JSON / session log 等）の変更追従に使う。同一 path の重複 watch は
 * refcount で共有し、変更は `fsChangeAbsolute { path }` として push される。 */
export interface FsWatchFileAbsoluteRequest {
  absolutePath: string;
}
export type FsWatchFileAbsoluteResponse = EmptyMessage;

/** 絶対パスの単一ファイル監視を解除する。refcount が 0 になったら watcher を破棄する。
 * watch されていない path でも no-op で成功する。 */
export interface FsUnwatchFileAbsoluteRequest {
  absolutePath: string;
}
export type FsUnwatchFileAbsoluteResponse = EmptyMessage;

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

/** fsExistsAbsolute が 1 回で受け付ける絶対パスの上限。
 * 要求件数を決めるのは端末出力に現れたトークンの数で、呼び出し側の実装だけに委ねない。
 * 呼び出し側の切り詰めと受け側の拒否が同じ値を見る。 */
export const FS_EXISTS_ABSOLUTE_MAX_PATHS = 32;

/** fsExistsAbsolute: 絶対パスの存在確認（dir 外を許可）。ターミナルのパスリンクが、検出した
 * 候補を実在で選別するために使う。path traversal の責任は呼び出し側に移譲する。
 * 件数が FS_EXISTS_ABSOLUTE_MAX_PATHS を超える要求は main 側が拒否する。 */
export interface FsExistsAbsoluteRequest {
  absolutePaths: string[];
}
export interface FsExistsAbsoluteResponse {
  /** absolutePaths と同じ並びで、各パスが存在するか */
  exists: boolean[];
}

// --- main → renderer push payloads (fs watch) ---

/** fsChange push payload。
 * `dir` は購読時に渡した dir（renderer 側 worktree dir と文字列同一）。
 * `relDir` は変更ファイルの親 dir を `dir` からの相対パスで表現する。
 * main 側 `relativeDir()`（fs/classify.ts）の SSOT に従い、worktree 直下は `""`、
 * サブディレクトリ配下は末尾 "/" を含まないディレクトリ相対パス。 */
export interface FsChangePayload {
  dir: string;
  relDir: string;
}

/** fsChangeAbsolute push payload。
 * fs/watchFileAbsolute で watch 中の絶対パスファイルの変更通知（main 側 absFileWatcher が発火元）。 */
export interface FsChangeAbsolutePayload {
  path: string;
}
