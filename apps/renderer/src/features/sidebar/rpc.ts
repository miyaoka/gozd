// sidebar が使う RPC wrapper。worktree / task を集約する。
import {
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  GitDefaultBranchRequest,
  GitDefaultBranchResponse,
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
  TaskUpdateRequest,
  TaskUpdateResponse,
} from "@gozd/proto";

import { rpc } from "../../shared/rpc";

// --- worktree ---

export const rpcGitWorktreeList = (req: GitWorktreeListRequest) =>
  rpc("/git/worktreeList", req, GitWorktreeListRequest, GitWorktreeListResponse);

export const rpcCreateWorktree = (req: CreateWorktreeRequest) =>
  rpc("/git/createWorktree", req, CreateWorktreeRequest, CreateWorktreeResponse);

export const rpcGitDefaultBranch = (req: GitDefaultBranchRequest) =>
  rpc("/git/defaultBranch", req, GitDefaultBranchRequest, GitDefaultBranchResponse);

export const rpcGitWorktreeRemove = (req: GitWorktreeRemoveRequest) =>
  rpc("/git/worktreeRemove", req, GitWorktreeRemoveRequest, GitWorktreeRemoveResponse);

// --- task ---

// task ≠ session 設計: task は PR/issue picker や手動操作で生まれる永続オブジェクト。
// Claude session は task に attach する短命属性として server 側で扱う。
export const rpcTaskAdd = (req: TaskAddRequest) =>
  rpc("/task/add", req, TaskAddRequest, TaskAddResponse);

export const rpcTaskUpdate = (req: TaskUpdateRequest) =>
  rpc("/task/update", req, TaskUpdateRequest, TaskUpdateResponse);

// --- app-state 永続化（sidebar repos / order / collapse の保存） ---

export const rpcAppStateLoad = (req: LoadAppStateRequest) =>
  rpc("/appState/load", req, LoadAppStateRequest, LoadAppStateResponse);

export const rpcAppStateSave = (req: SaveAppStateRequest) =>
  rpc("/appState/save", req, SaveAppStateRequest, SaveAppStateResponse);

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
