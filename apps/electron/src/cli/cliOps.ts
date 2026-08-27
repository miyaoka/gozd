// gozd-cli のコマンド構築ロジック（純関数部）。Swift 版 `GozdCLI/main.swift` の
// 対応物（issue #895「CLI: ソケットプロトコル互換を保って TS で再実装」）。
// ワイヤは ClientMessage の JSON 1 行（NDJSON）。形状は旧 proto3 JSON mapping と同一。

import type { GhRef, HookMessage, NewWorktreeMessage } from "@gozd/rpc";
import { ghRefForIssue, ghRefForPr } from "@gozd/rpc";
import type { Result } from "@gozd/shared";
import { tryCatch } from "@gozd/shared";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

// socket / launch dir で共有する prefix（Swift `bundlePrefix` と同じ値）
const BUNDLE_PREFIX = "gozd";

/** GOZD_SOCKET_PATH（非空）優先、無ければ stable channel の socket（Swift 版と同じ fallback） */
export function resolveSocketPath(env: Record<string, string | undefined>): string {
  const fromEnv = env.GOZD_SOCKET_PATH;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return join(tmpdir(), `${BUNDLE_PREFIX}-stable.sock`);
}

/** socket ファイル名 `gozd-<channel>.sock` から channel を抽出して launch dir を導出する。
 * 形式外は stable 扱い（Swift `launchRequestDir()` と同じ契約） */
export function launchRequestDirFromSocketPath(socketPath: string): string {
  const base = basename(socketPath);
  const prefix = `${BUNDLE_PREFIX}-`;
  const suffix = ".sock";
  if (base.startsWith(prefix) && base.endsWith(suffix)) {
    const channel = base.slice(prefix.length, base.length - suffix.length);
    return join(tmpdir(), `${BUNDLE_PREFIX}-${channel}-launch`);
  }
  return join(tmpdir(), `${BUNDLE_PREFIX}-stable-launch`);
}

/** cold start: launch request ファイルを書き出す（app が起動時に consume する） */
export function writeLaunchRequest(targetPath: string, socketPath: string): void {
  const dir = launchRequestDirFromSocketPath(socketPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${randomUUID()}.json`), JSON.stringify({ targetPath }));
}

/** background_tasks のエントリが teammate 型かどうか。teammate は idle 化しても
 * status "running" のまま session 終了まで残り続けるため、pendingWork の算出から除外する */
function isTeammateTask(task: unknown): boolean {
  if (typeof task !== "object" || task === null) return false;
  return (task as Record<string, unknown>).type === "teammate";
}

/** Claude Code が stdin で渡す hook JSON から HookMessage を組み立てる */
export function buildHookMessage(
  event: string,
  stdinJson: Record<string, unknown>,
  env: Record<string, string | undefined>,
): HookMessage {
  const ptyIdText = env.GOZD_PTY_ID ?? "";
  const ptyId = /^\d+$/.test(ptyIdText) ? Number(ptyIdText) : 0;

  const toolInput = stdinJson.tool_input;
  let toolInputText = "";
  if (typeof toolInput === "string") {
    toolInputText = toolInput;
  } else if (toolInput !== undefined) {
    toolInputText = JSON.stringify(toolInput);
  }

  // Stop (done) フックの pending work シグナル。teammate 型を除く background_tasks /
  // session_crons のいずれかが残っていれば true（旧バージョンのキー欠落は count 0 =
  // pending なし）。teammate の稼働判定は renderer が subagent lifecycle hook の台帳で行う
  const backgroundTasks = Array.isArray(stdinJson.background_tasks)
    ? stdinJson.background_tasks
    : [];
  const nonTeammateCount = backgroundTasks.filter((task) => !isTeammateTask(task)).length;
  const cronCount = Array.isArray(stdinJson.session_crons) ? stdinJson.session_crons.length : 0;

  return {
    event,
    ptyId,
    lastAssistantMessage:
      typeof stdinJson.last_assistant_message === "string" ? stdinJson.last_assistant_message : "",
    toolName: typeof stdinJson.tool_name === "string" ? stdinJson.tool_name : "",
    toolInput: toolInputText,
    sessionId: typeof stdinJson.session_id === "string" ? stdinJson.session_id : "",
    source: typeof stdinJson.source === "string" ? stdinJson.source : "",
    pendingWork: nonTeammateCount + cronCount > 0,
    hasTeammateTask: backgroundTasks.some(isTeammateTask),
    agentId: typeof stdinJson.agent_id === "string" ? stdinJson.agent_id : "",
    teammateName: typeof stdinJson.teammate_name === "string" ? stdinJson.teammate_name : "",
  };
}

/** stdin テキストを lenient に JSON parse する（空 / 壊れは空オブジェクト。Swift 版と同じ） */
export function parseStdinJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed === "") return {};
  const parsed = tryCatch(() => JSON.parse(trimmed) as unknown);
  if (!parsed.ok) return {};
  if (parsed.value !== null && typeof parsed.value === "object" && !Array.isArray(parsed.value)) {
    return parsed.value as Record<string, unknown>;
  }
  return {};
}

/** `gozd worktree new` が受け付ける、値を取るオプション。値は次の引数か `=` の右辺で渡す。 */
const NEW_WORKTREE_FLAGS = ["--title", "--prompt", "--dir", "--issue", "--pr"] as const;
type NewWorktreeFlag = (typeof NEW_WORKTREE_FLAGS)[number];

/** 値を取らないオプション。 */
const NEW_WORKTREE_SWITCHES = ["--prompt-stdin"] as const;
type NewWorktreeSwitch = (typeof NEW_WORKTREE_SWITCHES)[number];

function isNewWorktreeFlag(name: string): name is NewWorktreeFlag {
  return (NEW_WORKTREE_FLAGS as readonly string[]).includes(name);
}

function isNewWorktreeSwitch(name: string): name is NewWorktreeSwitch {
  return (NEW_WORKTREE_SWITCHES as readonly string[]).includes(name);
}

/** 解析結果。プロンプトを stdin から読むかは呼び出し側（IO を持つ層）が実行する。 */
export interface ParsedNewWorktree {
  message: NewWorktreeMessage;
  /** true なら message.prompt は空で、呼び出し側が stdin を読んで埋める */
  promptFromStdin: boolean;
}

/** `--issue` / `--pr` の番号。GitHub の番号は 1 始まりの整数以外を取らない */
function parseGhNumber(flag: NewWorktreeFlag, text: string): Result<number, string> {
  if (!/^\d+$/.test(text) || text === "0") {
    return { ok: false, error: `${flag} expects a positive number, got ${JSON.stringify(text)}` };
  }
  return { ok: true, value: Number(text) };
}

/**
 * `gozd worktree new` の引数を NewWorktreeMessage に組み立てる。
 *
 * `--title` は必須。タイトルの無い task はサイドバーで見分けが付かず、複数の worktree を
 * 並べて回す用途そのものが成立しないため、既定値で埋めずに失敗させる。
 */
export function parseNewWorktreeArgs(
  argv: string[],
  cwd: string,
): Result<ParsedNewWorktree, string> {
  const flags: Partial<Record<NewWorktreeFlag, string>> = {};
  let promptFromStdin = false;
  // オプション位置のトークンだけを解釈し、値は中身を見ずにそのまま取る。値まで走査すると
  // `--prompt "--dir=/tmp を直す"` のような「フラグに見える本文」が分解され、以降の対応が
  // ずれる。プロンプトはコマンド例を含みうるので現実に踏む
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    if (isNewWorktreeSwitch(name)) {
      promptFromStdin = true;
      continue;
    }
    if (!isNewWorktreeFlag(name)) return { ok: false, error: `unknown option: ${name}` };
    if (eq !== -1) {
      flags[name] = token.slice(eq + 1);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) return { ok: false, error: `${name} requires a value` };
    flags[name] = value;
    i += 1;
  }

  const title = flags["--title"] ?? "";
  if (title === "") return { ok: false, error: "--title is required" };

  if (promptFromStdin && flags["--prompt"] !== undefined) {
    return { ok: false, error: "--prompt and --prompt-stdin are mutually exclusive" };
  }

  const issue = flags["--issue"];
  const pr = flags["--pr"];
  if (issue !== undefined && pr !== undefined) {
    return { ok: false, error: "--issue and --pr are mutually exclusive" };
  }
  const ghNumber = issue ?? pr;
  let ghRef: GhRef | undefined;
  if (ghNumber !== undefined) {
    const parsed = parseGhNumber(issue !== undefined ? "--issue" : "--pr", ghNumber);
    if (!parsed.ok) return parsed;
    ghRef = issue !== undefined ? ghRefForIssue(parsed.value) : ghRefForPr(parsed.value);
  }

  return {
    ok: true,
    value: {
      message: {
        dir: resolve(cwd, flags["--dir"] ?? "."),
        title,
        prompt: flags["--prompt"] ?? "",
        ghRef,
      },
      promptFromStdin,
    },
  };
}
