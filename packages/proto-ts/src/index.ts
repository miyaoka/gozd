// 生成された RPC メッセージ型の barrel。
//
// `src/generated/` 配下が buf 管理（`clean: true` で全削除される領域）。
// この barrel は人間管理。新しい proto を追加した際はここに 1 行追加する。
//
// ts-proto は各ファイルに `DeepPartial` / `MessageFns` / `protobufPackage` という
// 共通の utility を export するため、`export *` だと衝突する。message 型のみを
// 明示 re-export する。
export {
  AppConfig,
  LoadAppConfigRequest,
  LoadAppConfigResponse,
  PreviewConfig,
  SaveAppConfigRequest,
  SaveAppConfigResponse,
  TerminalConfig,
  VoicevoxConfig,
} from "./generated/gozd/v1/app_config";
export {
  AppState,
  LoadAppStateRequest,
  LoadAppStateResponse,
  SaveAppStateRequest,
  SaveAppStateResponse,
  WindowFrame,
} from "./generated/gozd/v1/app_state";
export {
  ClaudeSession,
  ClaudeSessionList,
  ClaudeSessionListByDirRequest,
  ClaudeSessionListByDirResponse,
  ClaudeSessionRemoveByPtyRequest,
  ClaudeSessionRemoveByPtyResponse,
} from "./generated/gozd/v1/claude_session";
export { ClientMessage, HookMessage, OpenMessage } from "./generated/gozd/v1/client_message";
export { ghRefForIssue, ghRefForPr } from "./helpers";
export {
  FileEntry,
  FileReadResult,
  GhRef,
  GitCommit,
  GitFileChange,
  GitIssue,
  GitPullRequest,
  OpenTargetSelection,
  ProjectConfig,
  Task,
  UpstreamStatus,
  WorktreeEntry,
} from "./generated/gozd/v1/common";
export { EchoRequest, EchoResponse } from "./generated/gozd/v1/echo";
export {
  BranchChangeEvent,
  FsChangeEvent,
  GitStatusChangeEvent,
  GozdOpenEvent,
  NotifyEvent,
  WorktreeChangeEvent,
} from "./generated/gozd/v1/events";
export {
  FsReadDirEntry,
  FsReadDirRequest,
  FsReadDirResponse,
  FsReadFileRequest,
  FsReadFileResponse,
  FsUnwatchAllRequest,
  FsUnwatchAllResponse,
  FsUnwatchRequest,
  FsUnwatchResponse,
  FsWatchRequest,
  FsWatchResponse,
} from "./generated/gozd/v1/fs";
export {
  FsReadFileAbsoluteRequest,
  FsReadFileAbsoluteResponse,
  FsStatRequest,
  FsStatResponse,
  FsWriteFileRequest,
  FsWriteFileResponse,
} from "./generated/gozd/v1/fs_extra";
export {
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  DiffExpandedLine,
  DiffHunk,
  DiffHunkLine,
  DiffLineKind,
  GhErrorKind,
  GitCommitFilesRequest,
  GitCommitFilesResponse,
  GitDefaultBranchRequest,
  GitDefaultBranchResponse,
  GitDiffExpandLinesRequest,
  GitDiffExpandLinesResponse,
  GitDiffHunksRequest,
  GitDiffHunksResponse,
  GitFetchRemotesRequest,
  GitFetchRemotesResponse,
  GitIssueListRequest,
  GitIssueListResponse,
  GitLogRequest,
  GitLogResponse,
  GitPrListRequest,
  GitPrListResponse,
  GitShowCommitFileRequest,
  GitShowCommitFileResponse,
  GitShowFileRequest,
  GitShowFileResponse,
  GitViewerRequest,
  GitViewerResponse,
  GitWorktreeListRequest,
  GitWorktreeListResponse,
  GitWorktreeRemoveRequest,
  GitWorktreeRemoveResponse,
} from "./generated/gozd/v1/git_ops";
export { GitStatusRequest, GitStatusResponse } from "./generated/gozd/v1/git_status";
export { OpenExternalRequest, OpenExternalResponse } from "./generated/gozd/v1/open_external";
export { PickAndOpenRequest, PickAndOpenResponse } from "./generated/gozd/v1/open_target";
export {
  ProjectConfigLoadRequest,
  ProjectConfigLoadResponse,
  ProjectConfigSaveRequest,
  ProjectConfigSaveResponse,
} from "./generated/gozd/v1/project_config";
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
export {
  ShellCommandInstallRequest,
  ShellCommandInstallResponse,
  ShellCommandUninstallRequest,
  ShellCommandUninstallResponse,
} from "./generated/gozd/v1/shell_command";
export {
  TaskAddRequest,
  TaskAddResponse,
  TaskList,
  TaskUpdateRequest,
  TaskUpdateResponse,
} from "./generated/gozd/v1/task";
export {
  VoicevoxCheckEngineRequest,
  VoicevoxCheckEngineResponse,
  VoicevoxLaunchRequest,
  VoicevoxLaunchResponse,
  VoicevoxSpeakRequest,
  VoicevoxSpeakResponse,
} from "./generated/gozd/v1/voicevox";
export {
  WindowCloseRequest,
  WindowCloseResponse,
  WindowSetTitleContextRequest,
  WindowSetTitleContextResponse,
} from "./generated/gozd/v1/window";
