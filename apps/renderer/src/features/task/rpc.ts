// task が使う RPC wrapper。
import {
  TaskAddRequest,
  TaskAddResponse,
  TaskListRequest,
  TaskListResponse,
  TaskRemoveByWorktreeRequest,
  TaskRemoveByWorktreeResponse,
  TaskRemoveRequest,
  TaskRemoveResponse,
  TaskSetTerminalTitleRequest,
  TaskSetTerminalTitleResponse,
  TaskSetUserTitleRequest,
  TaskSetUserTitleResponse,
} from "@gozd/rpc";

import { rpc } from "../../shared/rpc";

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

// task 行 ⋮ メニューからの明示削除（1 件単位）。
export const rpcTaskRemove = (req: TaskRemoveRequest) =>
  rpc<TaskRemoveResponse>("/task/remove", req);

// worktree ⋮ メニューからの一括削除。worktree 削除 cascade の task 掃除だけを
// worktree を残したまま発火する（remove 不可の main worktree の滞留 task 一掃用）。
export const rpcTaskRemoveByWorktree = (req: TaskRemoveByWorktreeRequest) =>
  rpc<TaskRemoveByWorktreeResponse>("/task/removeByWorktree", req);
