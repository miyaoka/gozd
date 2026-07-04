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
} from "@gozd/rpc";

import { rpc } from "../../shared/rpc";

export const rpcGitLog = (req: GitLogRequest) => rpc<GitLogResponse>("/git/log", req);

export const rpcGitCommitFiles = (req: GitCommitFilesRequest) =>
  rpc<GitCommitFilesResponse>("/git/commitFiles", req);

export const rpcGitPrDiffFiles = (req: GitPrDiffFilesRequest) =>
  rpc<GitPrDiffFilesResponse>("/git/prDiffFiles", req);

export const rpcGitReadBlob = (req: GitReadBlobRequest) =>
  rpc<GitReadBlobResponse>("/git/readBlob", req);

export const rpcGitRevReachable = (req: GitRevReachableRequest) =>
  rpc<GitRevReachableResponse>("/git/revReachable", req);

export const rpcGitMergeBase = (req: GitMergeBaseRequest) =>
  rpc<GitMergeBaseResponse>("/git/mergeBase", req);

export const rpcGitResetMixed = (req: GitResetMixedRequest) =>
  rpc<GitResetMixedResponse>("/git/resetMixed", req);
