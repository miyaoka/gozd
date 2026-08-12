import type { Task, WorktreeEntry } from "@gozd/rpc";
import {
  branchLabel,
  resolveDisplayTitle,
  taskDisplayTitle,
  taskNumberPrefix,
} from "../../shared/repo";

/**
 * 編集 dialog の input placeholder 用: 「user_title を空にして Save したら表示される値」を
 * 返す。`taskDisplayTitle` を SSOT として参照することで、placeholder の予告と
 * サイドバーの実表示が必ず一致する (`#N ` prefix の有無 / "New session" フォールバック等)。
 */
export function placeholderForEmptyUserTitle(task: Task): string {
  return taskDisplayTitle({ ...task, userTitle: "" });
}

/**
 * worktree の表示名: 任意 Task に有効なタイトルがあればそれ、なければブランチ名。
 * gh_ref 付き task は `#N タイトル` の形で先頭に番号を付ける。
 */
export function worktreeDisplayName(wt: WorktreeEntry): string {
  for (const task of wt.tasks) {
    const title = resolveDisplayTitle(task);
    if (title !== undefined) return `${taskNumberPrefix(task)}${title}`;
  }
  return branchLabel(wt.branch);
}

/**
 * task 行の並び順。`createdAt` (静的) だけをキーにする。state や lastActivityAt のような
 * 動的値を混ぜると Claude の活動ごとに行位置が入れ替わり、ユーザーが「どこに何の task が
 * あるか」を空間記憶で辿れなくなる。同じ task 集合を wt カードと active session ペインの
 * 2 面に出すため、並びの規律も 2 面で共有する。
 */
export function compareTaskOrder(a: Task, b: Task): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

/** 変更ファイルがあるかどうか */
export function hasChanges(gitStatuses: Record<string, string> | undefined): boolean {
  if (!gitStatuses) return false;
  return Object.keys(gitStatuses).length > 0;
}
