import { GitStatusRequest, GitStatusResponse } from "@gozd/proto";

import { rpc } from "../../shared/rpc";

export const rpcGitStatus = (req: GitStatusRequest) =>
  rpc("/git/status", req, GitStatusRequest, GitStatusResponse);

// gitStatusChange push event payload
export interface GitStatusChangePayload {
  dir: string;
  statuses: Record<string, string>;
  head: string;
  hasUpstream: boolean;
  ahead: number;
  behind: number;
}
