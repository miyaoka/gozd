/**
 * repo 内の全 worktree の task を GhRef で引くための index。
 * PR / issue picker が「既に task が作成済みか」を fetch 時に JOIN し、選択時に
 * 新規 worktree 作成ではなく既存 task の worktree 表示へ倒すために使う。
 */

import type { GhRef, Task, WorktreeEntry } from "@gozd/rpc";

/** GhRef を Map キーに使う文字列へ正規化する。GitHub は PR / issue が同一の番号空間を
 * 共有するため kind + number の組で 1 キーになる。kind 文字列はここで組み立てず、
 * `ghRefForPr` / `ghRefForIssue`（`@gozd/rpc` ヘルパー）で作った GhRef を受け取る。 */
export function ghRefKey(ref: GhRef): string {
  return `${ref.kind}#${ref.number}`;
}

/**
 * worktree 横断で ghRef 付き task を index 化する。同一 ghRef の task が複数ある場合
 * （同 issue から複数 worktree を作った履歴がある場合）は createdAt が最新の 1 件を採用する。
 * createdAt は main 側 TaskStore が生成する同一書式の ISO 8601 のため文字列比較で足りる。
 * createdAt は秒粒度で同点がありうるため、同点は id 辞書順で決定論的に倒す
 * （main 側 taskStore.attachSession の pick と同じ tie-break）。
 */
export function buildTaskIndexByGhRef(worktrees: WorktreeEntry[]): Map<string, Task> {
  const index = new Map<string, Task>();
  for (const wt of worktrees) {
    for (const task of wt.tasks) {
      if (task.ghRef === undefined) continue;
      const key = ghRefKey(task.ghRef);
      const current = index.get(key);
      const wins =
        current === undefined ||
        task.createdAt > current.createdAt ||
        (task.createdAt === current.createdAt && task.id > current.id);
      if (wins) {
        index.set(key, task);
      }
    }
  }
  return index;
}
