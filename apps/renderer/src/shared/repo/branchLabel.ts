import type { WorktreeEntry } from "@gozd/rpc";

/** ワイヤ契約では detached HEAD を空文字の branch で表現する */
export function isDetached(branch: string): boolean {
  return branch === "";
}

/**
 * worktree の表示名。detached は branch を持たず、HEAD の hash も同じ commit から作った
 * worktree どうしで一致するため、repo 内で一意な path の末尾ディレクトリ名で見分ける。
 */
export function branchLabel(wt: Pick<WorktreeEntry, "branch" | "path">): string {
  if (!isDetached(wt.branch)) return wt.branch;
  const [last = wt.path] = wt.path
    .split("/")
    .filter((part) => part !== "")
    .slice(-1);
  return last;
}
