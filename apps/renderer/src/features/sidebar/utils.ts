import type { Task, WorktreeEntry } from "@gozd/rpc";
import { resolveDisplayTitle, taskDisplayTitle, taskNumberPrefix } from "../../shared/repo";

const DETACHED_BRANCH_LABEL = "(detached)";

/**
 * ワイヤ契約では detached HEAD を空文字で表現するため `??` では吸えない。
 * 「空文字 or undefined なら detached」を明示比較で判定する。
 */
export function branchLabel(branch: string | undefined): string {
  if (branch === undefined || branch === "") return DETACHED_BRANCH_LABEL;
  return branch;
}

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

/** 変更ファイルがあるかどうか */
export function hasChanges(gitStatuses: Record<string, string> | undefined): boolean {
  if (!gitStatuses) return false;
  return Object.keys(gitStatuses).length > 0;
}
