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

/** リポジトリパスをディレクトリ名にエンコードする */
function encodeRepoPath(repoRoot: string): string {
  return encodeURIComponent(repoRoot);
}

/** プロジェクト固有のデータディレクトリパスを返す */
function getProjectDir(repoRoot: string): string {
  return path.join(PROJECTS_DIR, encodeRepoPath(repoRoot));
}

function getTodosPath(repoRoot: string): string {
  return path.join(getProjectDir(repoRoot), TODOS_FILE);
}

function ensureProjectDir(repoRoot: string): void {
  const dir = getProjectDir(repoRoot);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Todo 一覧を読み込む（ファイル未作成なら空配列、それ以外のエラーは例外） */
export function loadTodos(repoRoot: string): Todo[] {
  const content = tryCatch(() => fs.readFileSync(getTodosPath(repoRoot), "utf-8"));
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
function saveTodos(repoRoot: string, todos: Todo[]): void {
  ensureProjectDir(repoRoot);
  fs.writeFileSync(getTodosPath(repoRoot), JSON.stringify(todos, null, 2));
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
export function addTodo(repoRoot: string, body: string, icon?: string, worktreeDir?: string): Todo {
  const todos = loadTodos(repoRoot);
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
  saveTodos(repoRoot, todos);
  return todo;
}

/** Todo の body と icon を更新する */
export function updateTodo(repoRoot: string, id: string, body: string, icon?: string): Todo {
  const todos = loadTodos(repoRoot);
  const todo = todos.find((t) => t.id === id);
  if (!todo) throw new Error(`Todo not found: ${id}`);
  todo.body = body;
  todo.icon = sanitizeIcon(icon);
  saveTodos(repoRoot, todos);
  return todo;
}

/** Todo を削除する */
export function removeTodo(repoRoot: string, id: string): void {
  const todos = loadTodos(repoRoot);
  const filtered = todos.filter((t) => t.id !== id);
  if (filtered.length === todos.length) return;
  saveTodos(repoRoot, filtered);
}

/** worktreeDir で Todo を検索する */
export function findTodoByWorktreeDir(repoRoot: string, worktreeDir: string): Todo | undefined {
  const todos = loadTodos(repoRoot);
  return todos.find((t) => t.worktreeDir === worktreeDir);
}

/** worktree に Todo を紐づける */
export function linkTodoToWorktree(repoRoot: string, id: string, worktreeDir: string): Todo {
  const todos = loadTodos(repoRoot);
  // 同じ worktreeDir に既に紐づいている Todo がないか検証
  if (todos.some((t) => t.worktreeDir === worktreeDir)) {
    throw new Error(`worktree already has a linked Todo: ${worktreeDir}`);
  }
  const todo = todos.find((t) => t.id === id);
  if (!todo) throw new Error(`Todo not found: ${id}`);
  if (todo.worktreeDir) throw new Error(`Todo already linked to a worktree: ${todo.worktreeDir}`);
  todo.worktreeDir = worktreeDir;
  saveTodos(repoRoot, todos);
  return todo;
}

/** worktreeDir が存在しない active Todo を削除する */
export function cleanupStaleTodos(repoRoot: string, validWorktreePaths: string[]): void {
  const todos = loadTodos(repoRoot);
  const validSet = new Set(validWorktreePaths);
  const cleaned = todos.filter((t) => {
    if (!t.worktreeDir) return true;
    return validSet.has(t.worktreeDir);
  });
  if (cleaned.length !== todos.length) {
    saveTodos(repoRoot, cleaned);
  }
}
