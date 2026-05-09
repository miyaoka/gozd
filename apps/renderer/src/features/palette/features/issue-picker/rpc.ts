import { GitIssueListRequest, GitIssueListResponse } from "@gozd/proto";

import { rpc } from "../../../../shared/rpc";

export const rpcGitIssueList = (req: GitIssueListRequest) =>
  rpc("/git/issueList", req, GitIssueListRequest, GitIssueListResponse);
