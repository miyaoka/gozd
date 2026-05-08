// sidebar が使う RPC wrapper。worktree / branch / task を集約する。
import {
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  CreateWorktreeWithTaskRequest,
  CreateWorktreeWithTaskResponse,
  GitBranchListRequest,
  GitBranchListResponse,
  GitWorktreeListRequest,
  GitWorktreeListResponse,
  GitWorktreeRemoveRequest,
  GitWorktreeRemoveResponse,
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

export const rpcGitWorktreeRemove = (req: GitWorktreeRemoveRequest) =>
  rpc("/git/worktreeRemove", req, GitWorktreeRemoveRequest, GitWorktreeRemoveResponse);

// --- task ---

export const rpcTaskAdd = (req: TaskAddRequest) =>
  rpc("/task/add", req, TaskAddRequest, TaskAddResponse);

export const rpcTaskUpdate = (req: TaskUpdateRequest) =>
  rpc("/task/update", req, TaskUpdateRequest, TaskUpdateResponse);

export const rpcCreateWorktreeWithTask = (req: CreateWorktreeWithTaskRequest) =>
  rpc(
    "/task/createWorktreeWithTask",
    req,
    CreateWorktreeWithTaskRequest,
    CreateWorktreeWithTaskResponse,
  );

// --- push event payloads ---

export interface BranchChangePayload {
  dir: string;
}

export interface WorktreeChangePayload {
  dir: string;
}
