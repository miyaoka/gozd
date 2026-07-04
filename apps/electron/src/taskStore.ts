// プロジェクト固有 Task の永続化。Swift 版 `Store/TaskStore.swift` /
// `Store/ProjectKey.swift` の対応物（現段階は list 経路のみ。add / attach 等の
// mutation は Claude hooks 統合ステップで移植する）。
//
// - projectKey は `<repoName>-<sha256(realpath)[0..12]>`。worktree 配下のどの dir から
//   呼ばれても main repo root に解決した上で同一 projectKey に揃える
// - 永続化形式は proto JSON（TaskList ラッパー）
// - parse 失敗時は**空 list で上書き save**する（後方互換を作らない規約。主データ
//   (git worktree list) を JOIN する立場のため、load 経路から throw を伝播させない）。
//   stderr に reinit ログを残して観察可能性を保つ

import { TaskList, type Task } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { runGit } from "./git/gitRunner";

const configDir = join(homedir(), ".config", "gozd");

/** realpath 解決。対象が存在しない等で失敗したら入力をそのまま返す
 * （Swift の resolvingSymlinksInPath は失敗しない API のため挙動を揃える） */
function realpathOrSelf(dir: string): string {
  const result = tryCatch(() => realpathSync(dir));
  return result.ok ? result.value : dir;
}

/** `git rev-parse --git-common-dir` の親 = main worktree のパス。git 外 / 失敗時は dir 自体 */
async function resolveMainRepoRoot(dir: string): Promise<string> {
  const result = await tryCatch(runGit(["rev-parse", "--git-common-dir"], dir));
  if (!result.ok) return realpathOrSelf(dir);
  const text = result.value.trim();
  // common-dir が相対パスなら dir 起点で resolve する
  const commonDir = isAbsolute(text) ? text : join(dir, text);
  return realpathOrSelf(dirname(commonDir));
}

/** main repo root から projectKey を生成する。形式変更は全 store の保存先を変えるため
 * 変更時は移行コードが必要（Swift 版 ProjectKey と完全同一の算式であること） */
function computeProjectKey(mainRepoRoot: string): string {
  const resolved = realpathOrSelf(mainRepoRoot);
  const hash = createHash("sha256").update(resolved, "utf8").digest("hex");
  return `${basename(resolved)}-${hash.slice(0, 12)}`;
}

/** dir（main / worktree / 配下 subdir のいずれでも可）から projectKey を解決する。
 * Swift 版 `ProjectKey.resolveAndCompute` の対応物。worktree 配置先の決定
 * （worktreeOps）と永続ファイルパスの両方がこの値を共有する */
export async function resolveProjectKey(dir: string): Promise<string> {
  return computeProjectKey(await resolveMainRepoRoot(dir));
}

async function tasksFilePath(dir: string): Promise<string> {
  const projectKey = computeProjectKey(await resolveMainRepoRoot(dir));
  return join(configDir, "projects", projectKey, "tasks.json");
}

function saveFile(path: string, list: TaskList): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(TaskList.toJSON(list)));
  renameSync(tmpPath, path);
}

async function loadFile(dir: string): Promise<TaskList> {
  const path = await tasksFilePath(dir);
  if (!existsSync(path)) return TaskList.fromJSON({});
  const parsed = tryCatch(() => TaskList.fromJSON(JSON.parse(readFileSync(path, "utf8"))));
  if (parsed.ok) return parsed.value;
  console.error(`[TaskStore] loadFile: parse failed at ${path}: ${parsed.error}`);
  const empty = TaskList.fromJSON({});
  saveFile(path, empty);
  console.error(`[TaskStore] loadFile: corrupted tasks.json reinitialized at ${path}`);
  return empty;
}

/** projectKey 内の全 Task を返す。handleGitWorktreeList の WorktreeEntry.tasks JOIN に使う */
export async function listTasks(dir: string): Promise<Task[]> {
  return (await loadFile(dir)).tasks;
}

/** worktree 物理削除からの連動掃除。該当 worktreeDir に紐づく全 Task を削除し、
 * worktree 削除後に Task が孤児として永続化に残るのを防ぐ */
export async function removeTasksByWorktree(dir: string, worktreePath: string): Promise<void> {
  const list = await loadFile(dir);
  list.tasks = list.tasks.filter((task) => task.worktreeDir !== worktreePath);
  saveFile(await tasksFilePath(dir), list);
}
