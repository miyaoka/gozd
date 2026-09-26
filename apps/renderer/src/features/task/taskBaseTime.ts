import type { Task } from "@gozd/rpc";
import { useNotificationStore } from "../../shared/notification";
import type { ClaudeStatus } from "../terminal";

/** 既に invalid を通知した taskId を保持し、再 fetch で同 task の重複通知を防ぐ */
const notifiedInvalidCreatedAtTaskIds = new Set<string>();

/**
 * 受信した tasks の `createdAt` を検証する ingress バリデータ。
 * main 側 (taskStore.ts) は ISO8601 を書く契約。パース失敗はワイヤ契約違反なので
 * 観察可能化のため `useNotificationStore.error` で通知する。task そのものは通す
 * （無効な createdAt 1 件のために UI から task を消す方が事故）。
 *
 * 同 taskId に対しては 1 度だけ通知する。RPC 再 fetch のたびに toast が重なるのを防ぐ。
 */
export function validateTasksCreatedAt(tasks: Task[]): void {
  const notify = useNotificationStore();
  for (const task of tasks) {
    if (!Number.isNaN(Date.parse(task.createdAt))) continue;
    if (notifiedInvalidCreatedAtTaskIds.has(task.id)) continue;
    notifiedInvalidCreatedAtTaskIds.add(task.id);
    notify.error(
      `Invalid task.createdAt (taskId=${task.id}, value=${JSON.stringify(task.createdAt)})`,
    );
  }
}

/**
 * Task 行の相対時刻基準（最終活動時刻）を決める SSOT。
 * - status があれば `lastActivityAt`
 * - 無ければセッションログの最終活動時刻（`useSessionLastActivityStore`）。
 *   session 未起動 / ログ未解決なら `undefined`
 */
export function resolveTaskBaseTime(
  status: ClaudeStatus | undefined,
  sessionLastActivity: number | undefined,
): number | undefined {
  if (status !== undefined) return status.lastActivityAt;
  return sessionLastActivity;
}
