import {
  GitCommitFilesRequest,
  GitCommitFilesResponse,
  GitLogRequest,
  GitLogResponse,
  GitRefsDigestRequest,
  GitRefsDigestResponse,
} from "@gozd/proto";

import { rpc } from "../../shared/rpc";

export const rpcGitLog = (req: GitLogRequest) =>
  rpc("/git/log", req, GitLogRequest, GitLogResponse);

export const rpcGitCommitFiles = (req: GitCommitFilesRequest) =>
  rpc("/git/commitFiles", req, GitCommitFilesRequest, GitCommitFilesResponse);

export const rpcGitRefsDigest = (req: GitRefsDigestRequest) =>
  rpc("/git/refsDigest", req, GitRefsDigestRequest, GitRefsDigestResponse);
