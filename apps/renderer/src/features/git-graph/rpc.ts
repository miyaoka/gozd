import {
  GitCommitFilesRequest,
  GitCommitFilesResponse,
  GitGithubIdentityRequest,
  GitGithubIdentityResponse,
  GitLogRequest,
  GitLogResponse,
  GitResetMixedRequest,
  GitResetMixedResponse,
} from "@gozd/proto";

import { rpc } from "../../shared/rpc";

export const rpcGitLog = (req: GitLogRequest) =>
  rpc("/git/log", req, GitLogRequest, GitLogResponse);

export const rpcGitCommitFiles = (req: GitCommitFilesRequest) =>
  rpc("/git/commitFiles", req, GitCommitFilesRequest, GitCommitFilesResponse);

export const rpcGitGithubIdentity = (req: GitGithubIdentityRequest) =>
  rpc("/git/githubIdentity", req, GitGithubIdentityRequest, GitGithubIdentityResponse);

export const rpcGitResetMixed = (req: GitResetMixedRequest) =>
  rpc("/git/resetMixed", req, GitResetMixedRequest, GitResetMixedResponse);
