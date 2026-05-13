// sidebar が使う RPC wrapper。worktree / task を集約する。
import {
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  GitDefaultBranchRequest,
  GitDefaultBranchResponse,
  GitWorktreeListRequest,
  GitWorktreeListResponse,
  GitWorktreeRemoveRequest,
  GitWorktreeRemoveResponse,
  LoadAppStateRequest,
  LoadAppStateResponse,
  SaveAppStateRequest,
  SaveAppStateResponse,
  TaskAddRequest,
  TaskAddResponse,
  TaskUpdateRequest,
  TaskUpdateResponse,
} from "@gozd/proto";

import { rpc } from "../../shared/rpc";

// --- worktree ---

export const rpcGitWorktreeList = (req: GitWorktreeListRequest) =>
  rpc("/git/worktreeList", req, GitWorktreeListRequest, GitWorktreeListResponse);

export const rpcCreateWorktree = (req: CreateWorktreeRequest) =>
  rpc("/git/createWorktree", req, CreateWorktreeRequest, CreateWorktreeResponse);

export const rpcGitDefaultBranch = (req: GitDefaultBranchRequest) =>
  rpc("/git/defaultBranch", req, GitDefaultBranchRequest, GitDefaultBranchResponse);

export const rpcGitWorktreeRemove = (req: GitWorktreeRemoveRequest) =>
  rpc("/git/worktreeRemove", req, GitWorktreeRemoveRequest, GitWorktreeRemoveResponse);

// --- task ---

export const rpcTaskAdd = (req: TaskAddRequest) =>
  rpc("/task/add", req, TaskAddRequest, TaskAddResponse);

export const rpcTaskUpdate = (req: TaskUpdateRequest) =>
  rpc("/task/update", req, TaskUpdateRequest, TaskUpdateResponse);

// --- app-state 永続化（sidebar repos / order / collapse の保存） ---

export const rpcAppStateLoad = (req: LoadAppStateRequest) =>
  rpc("/appState/load", req, LoadAppStateRequest, LoadAppStateResponse);

export const rpcAppStateSave = (req: SaveAppStateRequest) =>
  rpc("/appState/save", req, SaveAppStateRequest, SaveAppStateResponse);

// --- push event payloads ---

export interface BranchChangePayload {
  dir: string;
  /** 今回のバッチで動いた `refs/heads/` 配下の ref 名（prefix を剥がした basename）。
   * 例: `["main", "feat/foo"]`。`packed-refs` の更新で個別 ref を特定できない場合は空配列。
   * 観察可能性のため payload に含める（バグ報告 / ログ参照用）。
   * renderer 側の振る舞い（loadLog 全件 refetch）には現状影響しない。 */
  changedRefs: string[];
}

export interface WorktreeChangePayload {
  dir: string;
}

/** `useFsWatchSync` が `rpcFsWatch` 完了直後に renderer 内部で発射する再同期通知。
 * watch 開始往復中に起きた FS / refs 変化を救済するため、subscriber は受信時に
 * 1 回だけ自分の state を refetch する。type 名は `fsWatchReady` で固定。 */
export interface FsWatchReadyPayload {
  dir: string;
}
