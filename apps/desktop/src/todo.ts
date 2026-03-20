/**
 * Todo 管理モジュール
 *
 * worktree と 1:1 で紐づく Todo を JSON ファイルで永続化する。
 * 保存先: ~/.config/orkis/projects/<encodedPath>/todos.json
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { tryCatch } from "@orkis/shared";
import { todoSchema } from "@orkis/rpc";
import type { Todo } from "@orkis/rpc";

const PROJECTS_DIR = path.join(homedir(), ".config", "orkis", "projects");
const TODOS_FILE = "todos.json";

/** プロジェクトパスをディレクトリ名にエンコードする */
function encodeProjectPath(projectDir: string): string {
  return encodeURIComponent(projectDir);
}

/** プロジェクト固有のデータディレクトリパスを返す */
function getProjectDir(projectDir: string): string {
  return path.join(PROJECTS_DIR, encodeProjectPath(projectDir));
}

function getTodosPath(projectDir: string): string {
  return path.join(getProjectDir(projectDir), TODOS_FILE);
}

function ensureProjectDir(projectDir: string): void {
  const dir = getProjectDir(projectDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Todo 一覧を読み込む（ファイル未作成なら空配列、それ以外のエラーは例外） */
export function loadTodos(projectDir: string): Todo[] {
  const content = tryCatch(() => fs.readFileSync(getTodosPath(projectDir), "utf-8"));
  if (!content.ok) {
    // ファイルが存在しない場合のみ空配列を返す
    if ((content.error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw content.error;
  }
  const parsed = JSON.parse(content.value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("todos.json is not an array");
  return parsed.flatMap((v) => {
    const todo = parseTodo(v);
    return todo ? [todo] : [];
  });
}

/** Todo 一覧を保存する（失敗時は例外を投げる） */
function saveTodos(projectDir: string, todos: Todo[]): void {
  ensureProjectDir(projectDir);
  fs.writeFileSync(getTodosPath(projectDir), JSON.stringify(todos, null, 2));
}

/** zod スキーマで Todo をパースする（不正な値は除外） */
function parseTodo(v: unknown): Todo | undefined {
  const result = todoSchema.safeParse(v);
  return result.success ? result.data : undefined;
}

/** 許可リストにない icon を undefined に正規化する */
function sanitizeIcon(icon: string | undefined): Todo["icon"] {
  const result = todoSchema.shape.icon.safeParse(icon);
  return result.success ? result.data : undefined;
}

/** Todo を追加する */
export function addTodo(
  projectDir: string,
  body: string,
  icon?: string,
  worktreeDir?: string,
): Todo {
  const todos = loadTodos(projectDir);
  // worktreeDir が指定されている場合、既に紐づいている Todo がないか検証
  if (worktreeDir && todos.some((t) => t.worktreeDir === worktreeDir)) {
    throw new Error(`worktree already has a linked Todo: ${worktreeDir}`);
  }
  const todo: Todo = {
    id: crypto.randomUUID(),
    body,
    icon: sanitizeIcon(icon),
    worktreeDir,
    createdAt: new Date().toISOString(),
  };
  todos.push(todo);
  saveTodos(projectDir, todos);
  return todo;
}

/** Todo の body と icon を更新する */
export function updateTodo(projectDir: string, id: string, body: string, icon?: string): Todo {
  const todos = loadTodos(projectDir);
  const todo = todos.find((t) => t.id === id);
  if (!todo) throw new Error(`Todo not found: ${id}`);
  todo.body = body;
  todo.icon = sanitizeIcon(icon);
  saveTodos(projectDir, todos);
  return todo;
}

/** Todo を削除する */
export function removeTodo(projectDir: string, id: string): void {
  const todos = loadTodos(projectDir);
  const filtered = todos.filter((t) => t.id !== id);
  if (filtered.length === todos.length) return;
  saveTodos(projectDir, filtered);
}

/** worktreeDir で Todo を検索する */
export function findTodoByWorktreeDir(projectDir: string, worktreeDir: string): Todo | undefined {
  const todos = loadTodos(projectDir);
  return todos.find((t) => t.worktreeDir === worktreeDir);
}

/** worktree に Todo を紐づける */
export function linkTodoToWorktree(projectDir: string, id: string, worktreeDir: string): Todo {
  const todos = loadTodos(projectDir);
  // 同じ worktreeDir に既に紐づいている Todo がないか検証
  if (todos.some((t) => t.worktreeDir === worktreeDir)) {
    throw new Error(`worktree already has a linked Todo: ${worktreeDir}`);
  }
  const todo = todos.find((t) => t.id === id);
  if (!todo) throw new Error(`Todo not found: ${id}`);
  if (todo.worktreeDir) throw new Error(`Todo already linked to a worktree: ${todo.worktreeDir}`);
  todo.worktreeDir = worktreeDir;
  saveTodos(projectDir, todos);
  return todo;
}

/** worktreeDir が存在しない active Todo を削除する */
export function cleanupStaleTodos(projectDir: string, validWorktreePaths: string[]): void {
  const todos = loadTodos(projectDir);
  const validSet = new Set(validWorktreePaths);
  const cleaned = todos.filter((t) => {
    if (!t.worktreeDir) return true;
    return validSet.has(t.worktreeDir);
  });
  if (cleaned.length !== todos.length) {
    saveTodos(projectDir, cleaned);
  }
}
