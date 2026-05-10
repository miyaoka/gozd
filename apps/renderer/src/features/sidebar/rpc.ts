// sidebar が使う RPC wrapper。worktree / branch / task を集約する。
import {
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  GitBranchListRequest,
  GitBranchListResponse,
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

// --- worktree / branch ---

export const rpcGitWorktreeList = (req: GitWorktreeListRequest) =>
  rpc("/git/worktreeList", req, GitWorktreeListRequest, GitWorktreeListResponse);

export const rpcGitBranchList = (req: GitBranchListRequest) =>
  rpc("/git/branchList", req, GitBranchListRequest, GitBranchListResponse);

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
}

export interface WorktreeChangePayload {
  dir: string;
}
