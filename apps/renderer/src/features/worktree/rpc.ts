import {
  GitFetchOriginRequest,
  GitFetchOriginResponse,
  GitStatusRequest,
  GitStatusResponse,
} from "@gozd/proto";

import { rpc } from "../../shared/rpc";

export const rpcGitStatus = (req: GitStatusRequest) =>
  rpc("/git/status", req, GitStatusRequest, GitStatusResponse);

export const rpcGitFetchOrigin = (req: GitFetchOriginRequest) =>
  rpc("/git/fetchOrigin", req, GitFetchOriginRequest, GitFetchOriginResponse);

// gitStatusChange push event payload
export interface GitStatusChangePayload {
  dir: string;
  statuses: Record<string, string>;
  head: string;
  /** HEAD が指す branch 名（`git status --porcelain=v2 --branch` の `# branch.head`）。
   * `git branch -m` は OID を変えないため、rename はこの値の変化で検知する。
   * detached HEAD の場合は空文字。 */
  branchHead: string;
  hasUpstream: boolean;
  ahead: number;
  behind: number;
}
