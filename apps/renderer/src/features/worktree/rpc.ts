import {
  GitFetchRemotesRequest,
  GitFetchRemotesResponse,
  GitStatusRequest,
  GitStatusResponse,
  UpstreamStatus,
} from "@gozd/rpc";

import { rpc } from "../../shared/rpc";

export const rpcGitStatus = (req: GitStatusRequest) => rpc<GitStatusResponse>("/git/status", req);

export const rpcGitFetchRemotes = (req: GitFetchRemotesRequest) =>
  rpc<GitFetchRemotesResponse>("/git/fetchRemotes", req);

// gitStatusChange push event payload
export interface GitStatusChangePayload {
  dir: string;
  statuses: Record<string, string>;
  /** rename / copy エントリの 新パス → 旧パス。`statuses` のキーは新パスのみ持つため、
   * HEAD 側の比較元 (旧パス) はこの map で運ぶ。rename が無ければ空。 */
  renameOldPaths: Record<string, string>;
  head: string;
  /** HEAD が指す branch 名（`git status --porcelain=v2 --branch` の `# branch.head`）。
   * `git branch -m` は OID を変えないため、rename はこの値の変化で検知する。
   * detached HEAD の場合は空文字。 */
  branchHead: string;
  /** upstream 未設定なら不在。`undefined` なら ahead/behind を読まない契約。 */
  upstream?: UpstreamStatus;
  /** 変更ファイルの最終更新時刻 (Unix 秒)。clean / stat 全失敗のときは 0。 */
  latestMtime: number;
}
