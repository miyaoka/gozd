import {
  GitFetchRemotesRequest,
  GitFetchRemotesResponse,
  GitStatusRequest,
  GitStatusResponse,
  UpstreamStatus,
} from "@gozd/proto";

import { rpc } from "../../shared/rpc";

export const rpcGitStatus = (req: GitStatusRequest) =>
  rpc("/git/status", req, GitStatusRequest, GitStatusResponse);

export const rpcGitFetchRemotes = (req: GitFetchRemotesRequest) =>
  rpc("/git/fetchRemotes", req, GitFetchRemotesRequest, GitFetchRemotesResponse);

// gitStatusChange push event payload
export interface GitStatusChangePayload {
  dir: string;
  statuses: Record<string, string>;
  head: string;
  /** HEAD が指す branch 名（`git status --porcelain=v2 --branch` の `# branch.head`）。
   * `git branch -m` は OID を変えないため、rename はこの値の変化で検知する。
   * detached HEAD の場合は空文字。 */
  branchHead: string;
  /** upstream 未設定なら不在。`undefined` なら ahead/behind を読まない契約。 */
  upstream?: UpstreamStatus;
}
