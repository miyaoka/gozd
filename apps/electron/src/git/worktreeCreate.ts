// worktree を新規作成する経路。
//
// 置き場所・起点 ref・leaf 名の決定をここに閉じる。決定を呼び出し側に持たせると同じ規則の
// 写しが増え、規則を変えるたびに全経路を追うことになる。

import type { CreateWorktreeRequest, WorktreeEntry } from "@gozd/rpc";
import { generateTimestamp } from "@gozd/shared";
import { loadProjectConfig } from "../projectConfigStore";
import { resolveMainRepoRoot } from "../projectKey";
import { resolveStartPoint } from "./gitBranch";
import type { WorktreeInfo } from "./porcelain";
import { createWorktree } from "./worktreeOps";

/** 作成直後の worktree を WorktreeEntry に写す */
export function toWorktreeEntry(info: WorktreeInfo): WorktreeEntry {
  return {
    path: info.path,
    head: info.head,
    branch: info.branch ?? "",
    isMain: info.isMain,
  };
}

/** 起点 ref と leaf 名を解決して worktree を 1 つ作る。空文字の扱いは
 * `CreateWorktreeRequest` の契約を参照。 */
export async function resolveAndCreateWorktree(
  req: CreateWorktreeRequest,
): Promise<{ rootDir: string; info: WorktreeInfo; setupScript: string }> {
  // dir は repo 内のどこでもよい契約なので、worktree の配置先と projectKey が揃うよう
  // 先に main repo root へ解決する。
  const rootDir = await resolveMainRepoRoot(req.dir);
  // symlink 適用と setupScript は同じ project 設定なので 1 回の load で両方を賄う。
  const projectConfig = await loadProjectConfig(rootDir);
  const leaf = generateTimestamp();
  // branch だけ呼び出し側の指定を許すのは、PR の headRef を branch 名に載せたい経路があるため。
  // leaf 名にそれを使わないのは、同じ PR から作り直すと衝突するため
  const branch = req.branch === "" ? leaf : req.branch;
  // detached HEAD では resolveStartPoint が throw し、起点不明のまま作らずに失敗を返す
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
