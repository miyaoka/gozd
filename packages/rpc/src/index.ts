// RPC メッセージ型の barrel（旧 `.proto` SSOT の後継。手書き TS 型が SSOT）。
//
// ワイヤ契約: renderer ↔ main の request / response は Electron IPC の structured clone で
// plain data（JSON 形 + `WireBytes`）をそのまま運ぶ。Unix ソケットの ClientMessage は
// NDJSON（JSON 1 行）で、socket を通る型にバイナリは載せない。フィールド名は
// 旧 proto3 JSON mapping の lowerCamelCase を踏襲（永続化 JSON のキーと一致）。
// `?` フィールドは undefined（永続化 JSON ではキー不在）で未設定を表現する。
// 永続化ファイル（config.json / app-state.json / tasks.json 等）も同じ型で読み書きし、
// 旧ファイルの欠落フィールドは main 側 store の load 時に default 充填する。

export type {
  AppConfig,
  EnsureAppConfigFileRequest,
  EnsureAppConfigFileResponse,
  LoadAppConfigRequest,
  LoadAppConfigResponse,
  SaveAppConfigRequest,
  SaveAppConfigResponse,
} from "./appConfig";
export type {
  AppState,
  LoadAppStateRequest,
  LoadAppStateResponse,
  SaveAppStateRequest,
  SaveAppStateResponse,
  SidebarRepo,
  WorktreeCacheEntry,
} from "./appState";
export type {
  ClaudeSessionLogRequest,
  ClaudeSessionLogResponse,
  ClaudeSessionRemoveByPtyRequest,
  ClaudeSessionRemoveByPtyResponse,
  ReviveSessionInfo,
  ReviveSessionListRequest,
  ReviveSessionListResponse,
  ReviveSessionRequest,
  ReviveSessionResponse,
} from "./claudeSession";
export type { ClipboardCopyFilesRequest, ClipboardCopyFilesResponse } from "./clipboard";
export type { ClientMessage, HookMessage, OpenMessage } from "./clientMessage";
export type {
  FileReadResult,
  GhRef,
  GitCommit,
  GitFileChange,
  GitIssue,
  GitPullRequest,
  Task,
  UpstreamStatus,
  WireBytes,
  WorktreeEntry,
} from "./common";
export type { EchoRequest, EchoResponse } from "./echo";
export type {
  FsReadDirEntry,
  FsReadDirRequest,
  FsReadDirResponse,
  FsReadFileAbsoluteRequest,
  FsReadFileAbsoluteResponse,
  FsReadFileRequest,
  FsReadFileResponse,
  FsStatRequest,
  FsStatResponse,
  FsUnwatchAllRequest,
  FsUnwatchAllResponse,
  FsUnwatchFileAbsoluteRequest,
  FsUnwatchFileAbsoluteResponse,
  FsUnwatchRequest,
  FsUnwatchResponse,
  FsWatchFileAbsoluteRequest,
  FsWatchFileAbsoluteResponse,
  FsWatchRequest,
  FsWatchResponse,
  FsWriteFileAbsoluteRequest,
  FsWriteFileAbsoluteResponse,
  FsWriteFileRequest,
  FsWriteFileResponse,
} from "./fs";
export type {
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  DiffExpandedLine,
  DiffHunk,
  DiffLineKind,
  GhErrorKind,
  GitBlameCommit,
  GitBlameLineRequest,
  GitBlameLineResponse,
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
  GitGithubIdentityRequest,
  GitGithubIdentityResponse,
  GitIssueListRequest,
  GitIssueListResponse,
  GitLogFileRequest,
  GitLogFileResponse,
  GitLogLineRequest,
  GitLogLineResponse,
  GitLogRequest,
  GitLogResponse,
  GitLsFilesRequest,
  GitLsFilesResponse,
  GitLsTreeRequest,
  GitLsTreeResponse,
  GitMergeBaseRequest,
  GitMergeBaseResponse,
  GitPrDiffFilesRequest,
  GitPrDiffFilesResponse,
  GitPrListRequest,
  GitPrListResponse,
  GitReadBlobRequest,
  GitReadBlobResponse,
  GitResetMixedRequest,
  GitResetMixedResponse,
  GitRevReachableRequest,
  GitRevReachableResponse,
  GitShowCommitFileRequest,
  GitShowCommitFileResponse,
  GitShowFileRequest,
  GitShowFileResponse,
  GitTreeEntry,
  GitViewerRequest,
  GitViewerResponse,
  GitWorktreeListRequest,
  GitWorktreeListResponse,
  GitWorktreeRemoveRequest,
  GitWorktreeRemoveResponse,
  BranchScope,
  SortMode,
} from "./gitOps";
export type { GitStatusRequest, GitStatusResponse } from "./gitStatus";
export { ghRefForIssue, ghRefForPr, ghRefLabel } from "./helpers";
export type {
  OpenExternalRequest,
  OpenExternalResponse,
  OpenFileRequest,
  OpenFileResponse,
  PickAndOpenRequest,
  PickAndOpenResponse,
} from "./open";
export type {
  ProjectConfig,
  ProjectConfigEnsureFileRequest,
  ProjectConfigEnsureFileResponse,
  ProjectConfigLoadRequest,
  ProjectConfigLoadResponse,
  ProjectConfigSaveRequest,
  ProjectConfigSaveResponse,
} from "./projectConfig";
export type {
  PtyKillRequest,
  PtyKillResponse,
  PtyResizeRequest,
  PtyResizeResponse,
  PtySpawnRequest,
  PtySpawnResponse,
  PtyWriteRequest,
  PtyWriteResponse,
} from "./pty";
export type {
  ServerAttribution,
  ServerEntry,
  ServerListRequest,
  ServerListResponse,
} from "./server";
export type {
  TaskAddRequest,
  TaskAddResponse,
  TaskList,
  TaskListRequest,
  TaskListResponse,
  TaskRemoveByWorktreeRequest,
  TaskRemoveByWorktreeResponse,
  TaskRemoveRequest,
  TaskRemoveResponse,
  TaskSetTerminalTitleRequest,
  TaskSetTerminalTitleResponse,
  TaskSetUserTitleRequest,
  TaskSetUserTitleResponse,
} from "./task";
export type {
  VoicevoxCheckEngineRequest,
  VoicevoxCheckEngineResponse,
  VoicevoxLaunchRequest,
  VoicevoxLaunchResponse,
  VoicevoxListSpeakersRequest,
  VoicevoxListSpeakersResponse,
  VoicevoxSpeaker,
  VoicevoxSpeakRequest,
  VoicevoxSpeakResponse,
} from "./voicevox";
export type {
  WindowCloseRequest,
  WindowCloseResponse,
  WindowSetTitleContextRequest,
  WindowSetTitleContextResponse,
} from "./window";
