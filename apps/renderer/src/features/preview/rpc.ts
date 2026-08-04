import {
  GitBlameLineRequest,
  GitBlameLineResponse,
  GitDiffExpandLinesRequest,
  GitDiffExpandLinesResponse,
  GitDiffHunksRequest,
  GitDiffHunksResponse,
  GitLogFileRequest,
  GitLogFileResponse,
  GitLogLineRequest,
  GitLogLineResponse,
  GitShowCommitFileRequest,
  GitShowCommitFileResponse,
  GitShowFileRequest,
  GitShowFileResponse,
  OpenExternalRequest,
  OpenExternalResponse,
} from "@gozd/rpc";

import { rpc } from "../../shared/rpc";

/** URL を OS のデフォルトブラウザで開く。scheme allowlist は main 側の防壁。 */
export const rpcOpenExternal = (req: OpenExternalRequest) =>
  rpc<OpenExternalResponse>("/open/external", req);

export const rpcGitShowFile = (req: GitShowFileRequest) =>
  rpc<GitShowFileResponse>("/git/showFile", req);

export const rpcGitShowCommitFile = (req: GitShowCommitFileRequest) =>
  rpc<GitShowCommitFileResponse>("/git/showCommitFile", req);

export const rpcGitDiffHunks = (req: GitDiffHunksRequest) =>
  rpc<GitDiffHunksResponse>("/git/diffHunks", req);

export const rpcGitDiffExpandLines = (req: GitDiffExpandLinesRequest) =>
  rpc<GitDiffExpandLinesResponse>("/git/diffExpandLines", req);

export const rpcGitBlameLine = (req: GitBlameLineRequest) =>
  rpc<GitBlameLineResponse>("/git/blameLine", req);

export const rpcGitLogLine = (req: GitLogLineRequest) =>
  rpc<GitLogLineResponse>("/git/logLine", req);

export const rpcGitLogFile = (req: GitLogFileRequest) =>
  rpc<GitLogFileResponse>("/git/logFile", req);
