// Claude Code のタスク管理ツールが書き出すタスク一覧の読み取り。
//
// タスクは ~/.claude/tasks/<一覧の ID>/<id>.json に 1 件 1 ファイルで置かれる。一覧の ID は
// セッション ID だが、Agent Teams を率いるセッションはチーム名（`session-<セッション ID の
// 先頭 8 桁>`）を使う。形式は Claude Code の内部仕様なので、解釈はこのモジュールに閉じる。

import type { ClaudeTask, ClaudeTaskListResponse, ClaudeTaskStatus } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSafeSessionId } from "./claudeSessionLog";

function defaultTasksDir(): string {
  return join(homedir(), ".claude", "tasks");
}

const STATUSES: readonly ClaudeTaskStatus[] = ["pending", "in_progress", "completed"];

function isStatus(value: unknown): value is ClaudeTaskStatus {
  return STATUSES.some((status) => status === value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** metadata.goal。Claude Code の形式には目的の欄が無く、gozd が渡す指示で書かせる値 */
function readGoal(record: Record<string, unknown>): string {
  const metadata = record.metadata;
  if (typeof metadata !== "object" || metadata === null) return "";
  const goal = (metadata as Record<string, unknown>).goal;
  return typeof goal === "string" ? goal.trim() : "";
}

/** タスクファイル 1 件の内容を解釈する。表示に要る id / subject / status が揃わなければ
 * undefined を返す（理由はログに残す） */
function parseClaudeTask(content: string, path: string): ClaudeTask | undefined {
  const parsed = tryCatch(() => JSON.parse(content) as unknown);
  if (!parsed.ok) {
    // 書き込みの途中を読んだ場合もここに来る。次の hook で読み直される
    console.error(`[claudeTasks] invalid JSON, skipped: ${path}: ${String(parsed.error)}`);
    return undefined;
  }
  const raw = parsed.value;
  if (typeof raw !== "object" || raw === null) {
    console.error(`[claudeTasks] not an object, skipped: ${path}`);
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const { id, subject, status } = record;
  if (typeof id !== "string" || typeof subject !== "string" || !isStatus(status)) {
    console.error(
      `[claudeTasks] missing id/subject or unknown status, skipped: ${path} status=${String(status)}`,
    );
    return undefined;
  }
  const blockedBy = Array.isArray(record.blockedBy)
    ? record.blockedBy.filter((value): value is string => typeof value === "string")
    : [];
  return {
    id,
    subject,
    description: stringOr(record.description, ""),
    activeForm: stringOr(record.activeForm, ""),
    status,
    blockedBy,
    goal: readGoal(record),
  };
}

/** id は Claude Code が振る連番。数値として並べ、数値でなければ文字列の順に回す */
function compareTaskId(a: ClaudeTask, b: ClaudeTask): number {
  const na = Number(a.id);
  const nb = Number(b.id);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.id.localeCompare(b.id);
}

/**
 * 今の目的と、その目的のタスクを選ぶ。目的は目的を持つタスクのうち最も新しいものの値で、
 * ほかの目的のタスクは外す。目的を持たないタスクは、今の目的の最初のタスクより後にあれば
 * 残す（目的を付け忘れた手順）。目的が 1 件も無ければ全件を返す。
 */
export function selectCurrentGoal(tasks: readonly ClaudeTask[]): ClaudeTaskListResponse {
  const last = tasks.findLast((task) => task.goal !== "");
  if (last === undefined) return { goal: "", tasks: [...tasks] };
  const goal = last.goal;
  const first = tasks.findIndex((task) => task.goal === goal);
  return {
    goal,
    tasks: tasks.filter((task, index) => (task.goal === "" ? index > first : task.goal === goal)),
  };
}

function readTaskDir(dir: string): ClaudeTask[] {
  const tasks: ClaudeTask[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    const read = tryCatch(() => readFileSync(path, "utf8"));
    if (!read.ok) {
      // 一覧を取った後に削除されたファイル（status: deleted、全件完了での片付け）は ENOENT で
      // 来るので黙って外す。それ以外も壊れたファイルと同じく、そのファイルだけを外して残りを返す
      if ((read.error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[claudeTasks] unreadable, skipped: ${path}: ${String(read.error)}`);
      }
      continue;
    }
    const task = parseClaudeTask(read.value, path);
    if (task !== undefined) tasks.push(task);
  }
  return tasks.sort(compareTaskId);
}

/** dir の更新時刻。無ければ undefined。Claude Code はタスクを rename で書き換えるため、
 * dir の更新時刻が一覧の最終更新になる */
function dirMtime(dir: string): number | undefined {
  const stat = tryCatch(() => statSync(dir));
  if (!stat.ok) {
    if ((stat.error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw stat.error;
  }
  return stat.value.mtimeMs;
}

/** セッションのタスク一覧の dir。セッション ID の一覧とチーム名の一覧のうち、新しく
 * 書かれた方を選ぶ。どちらも無ければ undefined（タスクを 1 件も作っていない） */
function resolveTaskDir(sessionId: string, tasksDir: string): string | undefined {
  let found: { dir: string; mtime: number } | undefined;
  for (const name of [sessionId, `session-${sessionId.slice(0, 8)}`]) {
    const dir = join(tasksDir, name);
    const mtime = dirMtime(dir);
    if (mtime !== undefined && (found === undefined || mtime > found.mtime)) {
      found = { dir, mtime };
    }
  }
  return found?.dir;
}

/** セッションの今の目的とそのタスクを読む */
export function readClaudeTasks(
  sessionId: string,
  tasksDir = defaultTasksDir(),
): ClaudeTaskListResponse {
  if (!isSafeSessionId(sessionId)) {
    throw new Error(`invalid sessionId: ${sessionId}`);
  }
  const dir = resolveTaskDir(sessionId, tasksDir);
  if (dir === undefined) return { goal: "", tasks: [] };
  return selectCurrentGoal(readTaskDir(dir));
}
