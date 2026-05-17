import {
  GitDiffHunksRequest,
  GitDiffHunksResponse,
  GitShowCommitFileRequest,
  GitShowCommitFileResponse,
  GitShowFileRequest,
  GitShowFileResponse,
} from "@gozd/proto";

import { rpc } from "../../shared/rpc";

export const rpcGitShowFile = (req: GitShowFileRequest) =>
  rpc("/git/showFile", req, GitShowFileRequest, GitShowFileResponse);

export const rpcGitShowCommitFile = (req: GitShowCommitFileRequest) =>
  rpc("/git/showCommitFile", req, GitShowCommitFileRequest, GitShowCommitFileResponse);

export const rpcGitDiffHunks = (req: GitDiffHunksRequest) =>
  rpc("/git/diffHunks", req, GitDiffHunksRequest, GitDiffHunksResponse);
