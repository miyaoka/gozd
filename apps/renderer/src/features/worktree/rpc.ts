import {
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  GitDefaultBranchRequest,
  GitDefaultBranchResponse,
  GitFetchRemotesRequest,
  GitFetchRemotesResponse,
  GitGithubIdentityRequest,
  GitGithubIdentityResponse,
  GitPrListRequest,
  GitPrListResponse,
  GitStatusRequest,
  GitStatusResponse,
  GitWorktreeListRequest,
  GitWorktreeListResponse,
  GitWorktreeRemoveRequest,
  GitWorktreeRemoveResponse,
  UpstreamStatus,
} from "@gozd/rpc";

import { rpc } from "../../shared/rpc";

export const rpcGitStatus = (req: GitStatusRequest) => rpc<GitStatusResponse>("/git/status", req);

export const rpcGitFetchRemotes = (req: GitFetchRemotesRequest) =>
  rpc<GitFetchRemotesResponse>("/git/fetchRemotes", req);

export const rpcGitWorktreeList = (req: GitWorktreeListRequest) =>
  rpc<GitWorktreeListResponse>("/git/worktreeList", req);

// PR picker と git-graph の PR 列が共有する GitHub PR 一覧取得。
export const rpcGitPrList = (req: GitPrListRequest) => rpc<GitPrListResponse>("/git/prList", req);

export const rpcCreateWorktree = (req: CreateWorktreeRequest) =>
  rpc<CreateWorktreeResponse>("/git/createWorktree", req);

export const rpcGitDefaultBranch = (req: GitDefaultBranchRequest) =>
  rpc<GitDefaultBranchResponse>("/git/defaultBranch", req);

export const rpcGitWorktreeRemove = (req: GitWorktreeRemoveRequest) =>
  rpc<GitWorktreeRemoveResponse>("/git/worktreeRemove", req);

// origin remote のローカル parse で GitHub の (owner, repo) を返す（外部通信なし）。
// useSidebarData が repo 追加時に呼び、repoStore.githubIdentity（SSOT）へ書く唯一の取得口。
// sidebar の org アバターと git-graph の issue リンクが store 経由で共有する。
// 非 github.com / remote 未設定は空文字。
export const rpcGitGithubIdentity = (req: GitGithubIdentityRequest) =>
  rpc<GitGithubIdentityResponse>("/git/githubIdentity", req);

export interface BranchChangePayload {
  /** 同 repo を共有する worktree 群の中から primary 1 つだけが発火する。
   * `dir` は primary watcher の path で、active worktree とは限らない。subscriber が
   * 「同 repo の event か」を判定する場合は `findRepoOwning(dir).rootDir` を使う。 */
  dir: string;
}

/** `refs/remotes/*` / `packed-refs` の更新 (push / fetch 後) を repo スコープで通知する push。
 * `branchChange` と同じく commonGitDir 単位の primary watcher 1 つに collapse される。
 *
 * `gitStatusChange` との使い分け:
 *   - `gitStatusChange`: per-worktree の ahead/behind と HEAD を更新する経路。dir は source worktree
 *   - `remoteRefsChange`: 「remote ref トポロジが変わった」を repo スコープで通知する経路。
 *     current branch 以外の remote ref が動いた場合、`gitStatusChange` の upstream key は
 *     変化しないため、git log を再 load するトリガはこちらに頼る */
export interface RemoteRefsChangePayload {
  dir: string;
}

export interface WorktreeChangePayload {
  dir: string;
}

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
