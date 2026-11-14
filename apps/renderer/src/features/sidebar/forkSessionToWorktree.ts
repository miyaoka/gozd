/** docs/session.md の「行のメニュー」の「Fork into new worktree」 */
import { tryCatch } from "@gozd/shared";
import { useNotificationStore } from "../../shared/notification";
import type { SessionRow } from "../session";
import { openCreatedWorktree } from "../terminal";
import { rpcForkWorktree } from "../worktree";

export async function forkSessionToWorktree(row: SessionRow, rootDir: string): Promise<void> {
  const notify = useNotificationStore();
  const result = await tryCatch(rpcForkWorktree({ dir: rootDir, sessionId: row.sessionId }));
  if (!result.ok) {
    notify.error("Failed to fork the session into a new worktree", result.error);
    return;
  }
  openCreatedWorktree(result.value, { forkSessionId: row.sessionId }, "foreground");
}
