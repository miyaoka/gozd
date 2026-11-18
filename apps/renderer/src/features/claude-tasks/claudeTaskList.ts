import type { ClaudeTask, ClaudeTaskListResponse } from "@gozd/rpc";

export type ClaudeTaskList = ClaudeTaskListResponse;

export const EMPTY_TASK_LIST: ClaudeTaskList = { goal: "", tasks: [] };

function isAllCompleted(list: ClaudeTaskList): boolean {
  return list.tasks.length > 0 && list.tasks.every((task) => task.status === "completed");
}

/**
 * 読み直した一覧を保持中の一覧に重ねる。Claude Code は全件が完了した一覧をファイルごと
 * 片付けるため、読み直しで空になっても、保持中の一覧が全件完了ならそれを残す。
 * 残した一覧はセッションが終わるまで、次に新しいタスクが作られるまで表示する。
 */
export function mergeTaskList(previous: ClaudeTaskList | undefined, next: ClaudeTaskList) {
  if (next.tasks.length === 0 && previous !== undefined && isAllCompleted(previous)) {
    return previous;
  }
  return next;
}

export function completedCount(list: ClaudeTaskList): number {
  return list.tasks.filter((task) => task.status === "completed").length;
}

/** 一覧を 1 行で言うときの名前。目的が無ければ実行中の手順で代える */
export function taskListHeadline(list: ClaudeTaskList): string {
  if (list.goal !== "") return list.goal;
  const current = list.tasks.find((task) => task.status === "in_progress");
  if (current === undefined) return "";
  return current.activeForm === "" ? current.subject : current.activeForm;
}

/** 未完了の依存先が残っているか。完了した依存先が blockedBy に残っていても待ちではない */
export function isBlocked(task: ClaudeTask, tasks: readonly ClaudeTask[]): boolean {
  const openIds = new Set(tasks.filter((entry) => entry.status !== "completed").map((t) => t.id));
  return task.blockedBy.some((id) => openIds.has(id));
}
