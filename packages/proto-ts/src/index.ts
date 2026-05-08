// 生成された RPC メッセージ型の barrel。
//
// `src/generated/` 配下が buf 管理（`clean: true` で全削除される領域）。
// この barrel は人間管理。新しい proto を追加した際はここに 1 行追加する。
//
// ts-proto は各ファイルに `DeepPartial` / `MessageFns` / `protobufPackage` という
// 共通の utility を export するため、`export *` だと衝突する。message 型のみを
// 明示 re-export する。
export { EchoRequest, EchoResponse } from "./generated/gozd/v1/echo";
export {
  FsReadDirEntry,
  FsReadDirRequest,
  FsReadDirResponse,
  FsReadFileRequest,
  FsReadFileResponse,
} from "./generated/gozd/v1/fs";
export { GitStatusRequest, GitStatusResponse } from "./generated/gozd/v1/git_status";
export {
  PtyDataEvent,
  PtyExitEvent,
  PtyKillRequest,
  PtyKillResponse,
  PtyResizeRequest,
  PtyResizeResponse,
  PtySpawnRequest,
  PtySpawnResponse,
  PtyWriteRequest,
  PtyWriteResponse,
} from "./generated/gozd/v1/pty";
