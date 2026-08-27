import {
  CreateTaskWorktreeRequest,
  CreateTaskWorktreeResponse,
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  GitDefaultBranchRequest,
  GitDefaultBranchResponse,
  GitFetchRemotesRequest,
  GitFetchRemotesResponse,
  GitGithubIdentityRequest,
  GitGithubIdentityResponse,
  GitPrListRequest,
  GitPrListResponse,
  GitStatusRequest,
  GitStatusResponse,
  GitWorktreeListRequest,
  GitWorktreeListResponse,
  GitWorktreeRemoveRequest,
  GitWorktreeRemoveResponse,
} from "@gozd/rpc";

import { rpc } from "../../shared/rpc";

export const rpcGitStatus = (req: GitStatusRequest) => rpc<GitStatusResponse>("/git/status", req);

export const rpcGitFetchRemotes = (req: GitFetchRemotesRequest) =>
  rpc<GitFetchRemotesResponse>("/git/fetchRemotes", req);

export const rpcGitWorktreeList = (req: GitWorktreeListRequest) =>
  rpc<GitWorktreeListResponse>("/git/worktreeList", req);

// PR picker と git-graph の PR 列が共有する GitHub PR 一覧取得。
export const rpcGitPrList = (req: GitPrListRequest) => rpc<GitPrListResponse>("/git/prList", req);

export const rpcCreateWorktree = (req: CreateWorktreeRequest) =>
  rpc<CreateWorktreeResponse>("/git/createWorktree", req);

// worktree 作成 + task 紐づけの合成操作。PR / issue picker が使う。
// branch / startPoint は空文字で「main 側で決めろ」を意味する（@gozd/rpc の型を参照）。
export const rpcCreateTaskWorktree = (req: CreateTaskWorktreeRequest) =>
  rpc<CreateTaskWorktreeResponse>("/git/createTaskWorktree", req);

export const rpcGitDefaultBranch = (req: GitDefaultBranchRequest) =>
  rpc<GitDefaultBranchResponse>("/git/defaultBranch", req);

export const rpcGitWorktreeRemove = (req: GitWorktreeRemoveRequest) =>
  rpc<GitWorktreeRemoveResponse>("/git/worktreeRemove", req);

// origin remote のローカル parse で GitHub の (owner, repo) を返す（外部通信なし）。
// useSidebarData が repo 追加時に呼び、repoStore.githubIdentity（SSOT）へ書く唯一の取得口。
// sidebar の org アバターと git-graph の issue リンクが store 経由で共有する。
// 非 github.com / remote 未設定は空文字。
export const rpcGitGithubIdentity = (req: GitGithubIdentityRequest) =>
  rpc<GitGithubIdentityResponse>("/git/githubIdentity", req);
