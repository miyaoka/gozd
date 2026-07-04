import { GitIssueListRequest, GitIssueListResponse } from "@gozd/rpc";

import { rpc } from "../../../../shared/rpc";

export const rpcGitIssueList = (req: GitIssueListRequest) =>
  rpc<GitIssueListResponse>("/git/issueList", req);
