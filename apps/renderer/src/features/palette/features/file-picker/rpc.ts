import { GitLsFilesRequest, GitLsFilesResponse } from "@gozd/rpc";

import { rpc } from "../../../../shared/rpc";

export const rpcGitLsFiles = (req: GitLsFilesRequest) =>
  rpc<GitLsFilesResponse>("/git/lsFiles", req);
