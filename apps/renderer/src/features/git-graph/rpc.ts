import {
  GitCommitFilesRequest,
  GitCommitFilesResponse,
  GitLogRequest,
  GitLogResponse,
  GitMergeBaseRequest,
  GitMergeBaseResponse,
  GitPrDiffFilesRequest,
  GitPrDiffFilesResponse,
  GitReadBlobRequest,
  GitReadBlobResponse,
  GitResetMixedRequest,
  GitResetMixedResponse,
  GitRevReachableRequest,
  GitRevReachableResponse,
} from "@gozd/proto";

import { rpc } from "../../shared/rpc";

export const rpcGitLog = (req: GitLogRequest) =>
  rpc("/git/log", req, GitLogRequest, GitLogResponse);

export const rpcGitCommitFiles = (req: GitCommitFilesRequest) =>
  rpc("/git/commitFiles", req, GitCommitFilesRequest, GitCommitFilesResponse);

export const rpcGitPrDiffFiles = (req: GitPrDiffFilesRequest) =>
  rpc("/git/prDiffFiles", req, GitPrDiffFilesRequest, GitPrDiffFilesResponse);

export const rpcGitReadBlob = (req: GitReadBlobRequest) =>
  rpc("/git/readBlob", req, GitReadBlobRequest, GitReadBlobResponse);

export const rpcGitRevReachable = (req: GitRevReachableRequest) =>
  rpc("/git/revReachable", req, GitRevReachableRequest, GitRevReachableResponse);

export const rpcGitMergeBase = (req: GitMergeBaseRequest) =>
  rpc("/git/mergeBase", req, GitMergeBaseRequest, GitMergeBaseResponse);

export const rpcGitResetMixed = (req: GitResetMixedRequest) =>
  rpc("/git/resetMixed", req, GitResetMixedRequest, GitResetMixedResponse);
