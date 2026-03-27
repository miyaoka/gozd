/**
 * Task 管理モジュール
 *
 * worktree と 1:1 で紐づく Task を JSON ファイルで永続化する。
 * 保存先: ~/.config/gozd/projects/<projectKey>/tasks.json
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { tryCatch } from "@gozd/shared";
import { taskSchema } from "@gozd/rpc";
import type { Task } from "@gozd/rpc";
import { projectKey } from "./projectKey";

const PROJECTS_DIR = path.join(homedir(), ".config", "gozd", "projects");
const TASKS_FILE = "tasks.json";

/** プロジェクト固有のデータディレクトリパスを返す */
function getProjectDir(projectDir: string): string {
  return path.join(PROJECTS_DIR, projectKey(projectDir));
}

function getTasksPath(projectDir: string): string {
  return path.join(getProjectDir(projectDir), TASKS_FILE);
}

function ensureProjectDir(projectDir: string): void {
  const dir = getProjectDir(projectDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Task 一覧を読み込む（ファイル未作成なら空配列、それ以外のエラーは例外） */
export function loadTasks(projectDir: string): Task[] {
  const content = tryCatch(() => fs.readFileSync(getTasksPath(projectDir), "utf-8"));
  if (!content.ok) {
    // ファイルが存在しない場合のみ空配列を返す
    if ((content.error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw content.error;
  }
  const parsed = JSON.parse(content.value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("tasks.json is not an array");
  return parsed.flatMap((v) => {
    const task = parseTask(v);
    return task ? [task] : [];
  });
}

/** Task 一覧を保存する（失敗時は例外を投げる） */
function saveTasks(projectDir: string, tasks: Task[]): void {
  ensureProjectDir(projectDir);
  fs.writeFileSync(getTasksPath(projectDir), JSON.stringify(tasks, null, 2));
}

/** zod スキーマで Task をパースする（不正な値は除外） */
function parseTask(v: unknown): Task | undefined {
  const result = taskSchema.safeParse(v);
  return result.success ? result.data : undefined;
}

/** Task を追加する */
export function addTask(projectDir: string, body: string, worktreeDir?: string): Task {
  const tasks = loadTasks(projectDir);
  // worktreeDir が指定されている場合、既に紐づいている Task がないか検証
  if (worktreeDir && tasks.some((t) => t.worktreeDir === worktreeDir)) {
    throw new Error(`worktree already has a linked Task: ${worktreeDir}`);
  }
  const task: Task = {
    id: crypto.randomUUID(),
    body,
    worktreeDir,
    createdAt: new Date().toISOString(),
  };
  tasks.push(task);
  saveTasks(projectDir, tasks);
  return task;
}

/** Task の body を更新する */
export function updateTask(projectDir: string, id: string, body: string): Task {
  const tasks = loadTasks(projectDir);
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error(`Task not found: ${id}`);
  task.body = body;
  saveTasks(projectDir, tasks);
  return task;
}

/** Task を削除する */
export function removeTask(projectDir: string, id: string): void {
  const tasks = loadTasks(projectDir);
  const filtered = tasks.filter((t) => t.id !== id);
  if (filtered.length === tasks.length) return;
  saveTasks(projectDir, filtered);
}

/** worktreeDir で Task を検索する */
export function findTaskByWorktreeDir(projectDir: string, worktreeDir: string): Task | undefined {
  const tasks = loadTasks(projectDir);
  return tasks.find((t) => t.worktreeDir === worktreeDir);
}

/** worktree に Task を紐づける */
export function linkTaskToWorktree(projectDir: string, id: string, worktreeDir: string): Task {
  const tasks = loadTasks(projectDir);
  // 同じ worktreeDir に既に紐づいている Task がないか検証
  if (tasks.some((t) => t.worktreeDir === worktreeDir)) {
    throw new Error(`worktree already has a linked Task: ${worktreeDir}`);
  }
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error(`Task not found: ${id}`);
  if (task.worktreeDir) throw new Error(`Task already linked to a worktree: ${task.worktreeDir}`);
  task.worktreeDir = worktreeDir;
  saveTasks(projectDir, tasks);
  return task;
}

/** worktreeDir が存在しない active Task を削除する */
export function cleanupStaleTasks(projectDir: string, validWorktreePaths: string[]): void {
  const tasks = loadTasks(projectDir);
  const validSet = new Set(validWorktreePaths);
  const cleaned = tasks.filter((t) => {
    if (!t.worktreeDir) return true;
    return validSet.has(t.worktreeDir);
  });
  if (cleaned.length !== tasks.length) {
    saveTasks(projectDir, cleaned);
  }
}
