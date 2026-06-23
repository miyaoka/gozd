import {
  GitBlameLineRequest,
  GitBlameLineResponse,
  GitDiffExpandLinesRequest,
  GitDiffExpandLinesResponse,
  GitDiffHunksRequest,
  GitDiffHunksResponse,
  GitLogLineRequest,
  GitLogLineResponse,
  GitShowCommitFileRequest,
  GitShowCommitFileResponse,
  GitShowFileRequest,
  GitShowFileResponse,
  OpenFileRequest,
  OpenFileResponse,
} from "@gozd/proto";

import { rpc } from "../../shared/rpc";

export const rpcGitShowFile = (req: GitShowFileRequest) =>
  rpc("/git/showFile", req, GitShowFileRequest, GitShowFileResponse);

export const rpcGitShowCommitFile = (req: GitShowCommitFileRequest) =>
  rpc("/git/showCommitFile", req, GitShowCommitFileRequest, GitShowCommitFileResponse);

export const rpcGitDiffHunks = (req: GitDiffHunksRequest) =>
  rpc("/git/diffHunks", req, GitDiffHunksRequest, GitDiffHunksResponse);

export const rpcGitDiffExpandLines = (req: GitDiffExpandLinesRequest) =>
  rpc("/git/diffExpandLines", req, GitDiffExpandLinesRequest, GitDiffExpandLinesResponse);

export const rpcGitBlameLine = (req: GitBlameLineRequest) =>
  rpc("/git/blameLine", req, GitBlameLineRequest, GitBlameLineResponse);

export const rpcGitLogLine = (req: GitLogLineRequest) =>
  rpc("/git/logLine", req, GitLogLineRequest, GitLogLineResponse);

/** 表示中ファイルを OS のデフォルトアプリで開く（macOS の `open` 相当）。path は絶対パス。 */
export const rpcOpenFile = (req: OpenFileRequest) =>
  rpc("/open/file", req, OpenFileRequest, OpenFileResponse);
