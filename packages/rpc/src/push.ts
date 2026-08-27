// main → renderer push の type 名と payload 型の束縛。
// 送信側 (PushFn) はこの map で型検査され、type 名の取り違えと未登録 push が
// コンパイルエラーになる。新しい push を足すときはここに 1 行追加する
// （docs/rpc.md の push 一覧と対応する）。
//
// renderer 内部イベント（fsWatchReady / claudeFx）はワイヤ契約ではないため載せない。
// 受信側 (onMessage) が generic のままなのは、同じバスに renderer 内部イベントが
// 乗るため（shared/rpc/messages.ts の設計判断を参照）。
import type { AppConfigChangePayload } from "./appConfig";
import type { HookPayload } from "./clientMessage";
import type { FsChangeAbsolutePayload, FsChangePayload } from "./fs";
import type {
  BranchChangePayload,
  GitStatusChangePayload,
  RemoteRefsChangePayload,
  WorktreeChangePayload,
} from "./gitStatus";
import type { NewWorktreePayload } from "./gitOps";
import type { GozdOpenPayload } from "./open";
import type { DebugLogPayload, NotifyPayload } from "./observability";
import type { PtyExitPayload, PtyTextPayload } from "./pty";
import type { ServerPortsChangePayload } from "./server";
import type { TextSearchMatchPayload } from "./textSearch";
import type { WindowFullscreenChangePayload } from "./window";

export interface PushPayloadMap {
  appConfigChange: AppConfigChangePayload;
  branchChange: BranchChangePayload;
  debugLog: DebugLogPayload;
  fsChange: FsChangePayload;
  fsChangeAbsolute: FsChangeAbsolutePayload;
  gitStatusChange: GitStatusChangePayload;
  gozdOpen: GozdOpenPayload;
  hook: HookPayload;
  newWorktree: NewWorktreePayload;
  notify: NotifyPayload;
  ptyExit: PtyExitPayload;
  ptyText: PtyTextPayload;
  remoteRefsChange: RemoteRefsChangePayload;
  serverPortsChange: ServerPortsChangePayload;
  textSearchMatch: TextSearchMatchPayload;
  windowFullscreenChange: WindowFullscreenChangePayload;
  worktreeChange: WorktreeChangePayload;
}
