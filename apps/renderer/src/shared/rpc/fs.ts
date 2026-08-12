// worktree dir 単位のファイル監視 RPC と、renderer 内部の再同期シグナル契約の置き場。
// 複数 feature が同じ watch 基盤を共有するため、層をまたぐ単一物としてここに置く
// （ワイヤ push の payload 型は @gozd/rpc 側にある）。
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

/** `useFsWatchSync` が `rpcFsWatch` 成功ごとに renderer 内部で発射する再同期通知。
 * 新規 watch を開始した dir 1 件につき 1 push。subscriber は `payload.dir` を見て
 * 自分が関心ある dir のものだけにフィルタする。dir を載せない設計だと N watch 起動 ×
 * M 購読者の cross product で fan-out し、全 worktree watch 拡張後は GitHub rate
 * limit を食い潰す原因になる。 */
export interface FsWatchReadyPayload {
  dir: string;
}
