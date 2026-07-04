// sidebar が使う RPC wrapper。worktree / task を集約する。
import {
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  GitDefaultBranchRequest,
  GitDefaultBranchResponse,
  GitGithubIdentityRequest,
  GitGithubIdentityResponse,
  GitWorktreeListRequest,
  GitWorktreeListResponse,
  GitWorktreeRemoveRequest,
  GitWorktreeRemoveResponse,
  LoadAppStateRequest,
  LoadAppStateResponse,
  SaveAppStateRequest,
  SaveAppStateResponse,
  TaskAddRequest,
  TaskAddResponse,
  TaskListRequest,
  TaskListResponse,
  TaskRemoveRequest,
  TaskRemoveResponse,
  TaskSetTerminalTitleRequest,
  TaskSetTerminalTitleResponse,
  TaskSetUserTitleRequest,
  TaskSetUserTitleResponse,
} from "@gozd/rpc";

import { rpc } from "../../shared/rpc";

// --- worktree ---

export const rpcGitWorktreeList = (req: GitWorktreeListRequest) =>
  rpc<GitWorktreeListResponse>("/git/worktreeList", req);

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

// --- task ---

// git 非依存で tasks.json だけを読む高速経路。起動直後、worktree キャッシュから描画した
// カードに task 行を即埋めるために使う（重い rpcGitWorktreeList の git 部分を待たない）。
export const rpcTaskList = (req: TaskListRequest) => rpc<TaskListResponse>("/task/list", req);

// task ≠ session 設計: task は PR/issue picker や手動操作で生まれる永続オブジェクト。
// Claude session は task に attach する短命属性として server 側で扱う。
export const rpcTaskAdd = (req: TaskAddRequest) => rpc<TaskAddResponse>("/task/add", req);

// OSC ターミナルタイトルの観測値書き込み。user_title が空の表示フォールバックに使う。
export const rpcTaskSetTerminalTitle = (req: TaskSetTerminalTitleRequest) =>
  rpc<TaskSetTerminalTitleResponse>("/task/setTerminalTitle", req);

// 編集 dialog からのユーザー明示タイトル設定。空文字は user_title をクリアし、
// 表示は gh_title / terminal_title のフォールバックチェーンに戻る (= reset 経路)。
export const rpcTaskSetUserTitle = (req: TaskSetUserTitleRequest) =>
  rpc<TaskSetUserTitleResponse>("/task/setUserTitle", req);

// ⋮ メニューからの明示削除。worktree 削除 cascade と並ぶ唯一のユーザー操作削除経路。
export const rpcTaskRemove = (req: TaskRemoveRequest) =>
  rpc<TaskRemoveResponse>("/task/remove", req);

// --- app-state 永続化（sidebar repos / order / collapse の保存） ---

export const rpcAppStateLoad = (req: LoadAppStateRequest) =>
  rpc<LoadAppStateResponse>("/appState/load", req);

export const rpcAppStateSave = (req: SaveAppStateRequest) =>
  rpc<SaveAppStateResponse>("/appState/save", req);

// --- push event payloads ---

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

/** `useFsWatchSync` が `rpcFsWatch` 成功ごとに renderer 内部で発射する再同期通知。
 * 新規 watch を開始した dir 1 件につき 1 push。subscriber は `payload.dir` を見て
 * 自分が関心ある dir のものだけにフィルタする。dir を載せない設計だと N watch 起動 ×
 * M 購読者の cross product で fan-out し、全 worktree watch 拡張後は GitHub rate
 * limit を食い潰す原因になる。 */
export interface FsWatchReadyPayload {
  dir: string;
}
