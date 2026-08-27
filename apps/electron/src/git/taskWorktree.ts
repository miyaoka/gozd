// worktree 作成と task 紐づけの合成操作。
//
// 「worktree はあるが task が無い」中間状態を呼び出し側に見せないために 1 つの単位にする。
// 中断すると worktree だけがサイドバーに残り、ユーザーが `git worktree remove` で手作業の
// 回収を強いられる。呼び出し側は UI の PR / issue picker と socket の `gozd worktree new` の
// 2 つで、どちらもこの関数だけを通る。

import type {
  CreateTaskWorktreeRequest,
  CreateTaskWorktreeResponse,
  Task,
  WorktreeEntry,
} from "@gozd/rpc";
import { generateTimestamp } from "@gozd/shared";
import { loadProjectConfig } from "../projectConfigStore";
import { resolveMainRepoRoot, taskStore } from "../taskStore";
import { resolveStartPoint } from "./gitBranch";
import type { WorktreeInfo } from "./porcelain";
import { createWorktree } from "./worktreeOps";

/** 作成直後の worktree を WorktreeEntry に写す。git status / mtime は fs 監視と
 * `worktreeList` の後追いで埋まるため、ここでは空で送り出す。 */
export function toWorktreeEntry(info: WorktreeInfo, tasks: Task[]): WorktreeEntry {
  return {
    path: info.path,
    head: info.head,
    branch: info.branch ?? "",
    isMain: info.isMain,
    gitStatuses: {},
    renameOldPaths: {},
    latestMtime: 0,
    upstream: undefined,
    tasks,
  };
}

/** worktree を 1 つ作る。root の解決・起点 ref・leaf 名の決定を main 側に閉じる。
 *
 * 呼び出し側は repo 内のどこかの dir を渡すだけでよい。「どこに置くか」「どこから生やすか」
 * 「何という名前にするか」を各呼び出し側が決めると、同じ規則の写しが増え、規則を変えるたびに
 * 全部を追う必要が出る。 */
export async function createManagedWorktree(req: {
  dir: string;
  /** 空なら leaf と同じ timestamp を使う */
  branch: string;
  /** 空なら default branch を起点にする */
  startPoint: string;
}): Promise<{ rootDir: string; info: WorktreeInfo; setupScript: string }> {
  // dir は repo 内のどこでもよい契約なので、worktree の配置先と projectKey が揃うよう
  // 先に main repo root へ解決する。
  const rootDir = await resolveMainRepoRoot(req.dir);
  // symlink 適用と setupScript は同じ project 設定なので 1 回の load で両方を賄う。
  const projectConfig = await loadProjectConfig(rootDir);
  // leaf は常に timestamp。branch 名は呼び出し側が意味のある名前（PR の headRef）を
  // 指定でき、未指定なら leaf と同じ timestamp を使う。
  const leaf = generateTimestamp();
  const branch = req.branch === "" ? leaf : req.branch;
  // startPoint 未指定は default branch 起点。detached HEAD では resolveStartPoint が throw し、
  // 起点不明のまま作らずに呼び出し側へ失敗を返す。
  const startPoint = req.startPoint === "" ? await resolveStartPoint(rootDir) : req.startPoint;

  const info = await createWorktree({
    dir: rootDir,
    worktreeDir: leaf,
    branch,
    startPoint,
    symlinks: projectConfig.worktreeSymlinks,
  });
  return { rootDir, info, setupScript: projectConfig.setupScript };
}

export async function createTaskWorktree(
  req: CreateTaskWorktreeRequest,
): Promise<CreateTaskWorktreeResponse> {
  const { rootDir, info, setupScript } = await createManagedWorktree(req);
  const task = await taskStore.add({
    dir: rootDir,
    ghTitle: req.ghTitle,
    worktreeDir: info.path,
    ghRef: req.ghRef,
  });
  return {
    rootDir,
    worktree: toWorktreeEntry(info, [task]),
    dir: info.path,
    task,
    setupScript,
  };
}
