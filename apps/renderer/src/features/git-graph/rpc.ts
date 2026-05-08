import {
  GitCommitFilesRequest,
  GitCommitFilesResponse,
  GitLogRequest,
  GitLogResponse,
} from "@gozd/proto";

import { rpc } from "../../shared/rpc";

export const rpcGitLog = (req: GitLogRequest) =>
  rpc("/git/log", req, GitLogRequest, GitLogResponse);

export const rpcGitCommitFiles = (req: GitCommitFilesRequest) =>
  rpc("/git/commitFiles", req, GitCommitFilesRequest, GitCommitFilesResponse);
