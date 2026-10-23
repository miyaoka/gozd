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
  PreviewServingUrlRequest,
  PreviewServingUrlResponse,
  PreviewReleaseServingRequest,
  PreviewReleaseServingResponse,
} from "@gozd/rpc";

import { rpc } from "../../shared/rpc";

/** preview 対象の配信 URL を得る（同時に配信 root が main へ登録される） */
export const rpcPreviewServingUrl = (req: PreviewServingUrlRequest) =>
  rpc<PreviewServingUrlResponse>("/preview/servingUrl", req);

/** preview が閉じた / 対象を変えたときに配信許可を手放す */
export const rpcPreviewReleaseServing = (req: PreviewReleaseServingRequest) =>
  rpc<PreviewReleaseServingResponse>("/preview/releaseServing", req);

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
