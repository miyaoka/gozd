// worktree dir 単位のファイル監視 RPC と push payload 契約の置き場。複数 feature が
// 同じ watch 基盤を共有するため、層をまたぐ単一物としてここに置く
// （docs/architecture.md「ファイル監視」の再同期シグナル契約）。
import type {
  FsUnwatchAllRequest,
  FsUnwatchAllResponse,
  FsUnwatchRequest,
  FsUnwatchResponse,
  FsWatchRequest,
  FsWatchResponse,
} from "@gozd/rpc";

import { rpc } from "./client";

export const rpcFsWatch = (req: FsWatchRequest) => rpc<FsWatchResponse>("/fs/watch", req);

export const rpcFsUnwatch = (req: FsUnwatchRequest) => rpc<FsUnwatchResponse>("/fs/unwatch", req);

export const rpcFsUnwatchAll = (req: FsUnwatchAllRequest) =>
  rpc<FsUnwatchAllResponse>("/fs/unwatchAll", req);

// fsChange push event payload.
// `dir` は購読時に渡した dir（renderer 側 worktree dir と文字列同一）。
// `relDir` は変更ファイルの親 dir を `dir` からの相対パスで表現する。
// main 側 `relativeDir()`（fs/classify.ts）の SSOT に従い、worktree 直下は `""`、
// サブディレクトリ配下は末尾 "/" を含まないディレクトリ相対パス。
export interface FsChangePayload {
  dir: string;
  relDir: string;
}

/** `useFsWatchSync` が `rpcFsWatch` 成功ごとに renderer 内部で発射する再同期通知。
 * 新規 watch を開始した dir 1 件につき 1 push。subscriber は `payload.dir` を見て
 * 自分が関心ある dir のものだけにフィルタする。dir を載せない設計だと N watch 起動 ×
 * M 購読者の cross product で fan-out し、全 worktree watch 拡張後は GitHub rate
 * limit を食い潰す原因になる。 */
export interface FsWatchReadyPayload {
  dir: string;
}
