// プロジェクト固有の Task 永続化 (`~/.config/gozd/projects/<projectKey>/tasks.json`) と
// Task 系 RPC の型。
//
// task ≠ Claude session。task は PR / issue / 手動作成で生まれ、worktree の寿命に
// 揃った永続オブジェクト。Claude session は task に attach する短命属性として
// task.sessionId に格納する。SessionStart で attach、SessionEnd では切り離さず保持し
// 次回 `claude --resume` の起点に使う。
//
// projectKey は dir の realpath から main 側で算出する。renderer は dir のみ渡す。

import type { EmptyMessage, GhRef, Task } from "./common";

/** TaskStore の永続化形式（tasks.json）。 */
export interface TaskList {
  tasks: Task[];
}

/** git 非依存で tasks.json だけを読む高速経路。起動直後、worktree キャッシュから描画した
 * カードに task 行を即埋めるために使う（重い rpcGitWorktreeList の git 部分を待たずに
 * task を出す）。 */
export interface TaskListRequest {
  dir: string;
}
export interface TaskListResponse {
  tasks: Task[];
}

export interface TaskAddRequest {
  dir: string;
  worktreeDir: string;
  /** GitHub PR / issue 参照。手動作成時は未指定で OK。 */
  ghRef?: GhRef;
  /** PR/issue picker からの snapshot タイトル。新規 task の ghTitle に入る。
   * upsert (同 worktree + 同 ghRef) では既存 task の ghTitle を上書きする。
   * userTitle はこの経路では一切扱わない (編集 dialog 専用)。 */
  ghTitle: string;
}
export interface TaskAddResponse {
  task: Task;
}

/** OSC ターミナルタイトルの観測値を Task に書き込む経路。renderer の useSidebarData が
 * terminal title 変化を観測して呼ぶ。userTitle が空のときの表示フォールバックに使う。 */
export interface TaskSetTerminalTitleRequest {
  dir: string;
  id: string;
  terminalTitle: string;
}
export interface TaskSetTerminalTitleResponse {
  task: Task;
}

/** 編集 dialog からのユーザー明示タイトル設定。
 * 空文字を渡すと userTitle をクリアし、表示は ghTitle / terminalTitle の
 * 自然なフォールバックチェーンに戻る (= reset 経路)。 */
export interface TaskSetUserTitleRequest {
  dir: string;
  id: string;
  userTitle: string;
}
export interface TaskSetUserTitleResponse {
  task: Task;
}

/** ⋮ メニューからの明示削除。worktree 削除 cascade とは別経路。
 * root worktree のように `git worktree remove` できない場所で生まれた task や、
 * closedByUser で滞留した task を片付けるためのユーザー操作。 */
export interface TaskRemoveRequest {
  dir: string;
  id: string;
}
export type TaskRemoveResponse = EmptyMessage;

/** ⋮ メニューからの worktree 単位の一括削除。worktree 削除 cascade と同じ掃除
 * （removeByWorktree）を worktree を残したまま単独発火する経路。
 * `git worktree remove` できない main worktree に滞留した task（= サイドバーの
 * session 行）を一掃するためのユーザー操作。Claude セッションの JSONL は消さない。 */
export interface TaskRemoveByWorktreeRequest {
  dir: string;
  worktreeDir: string;
}
export type TaskRemoveByWorktreeResponse = EmptyMessage;
