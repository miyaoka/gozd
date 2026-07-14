// gozd-cli のコマンド構築ロジック（純関数部）。Swift 版 `GozdCLI/main.swift` の
// 対応物（issue #895「CLI: ソケットプロトコル互換を保って TS で再実装」）。
// ワイヤは ClientMessage の JSON 1 行（NDJSON）。形状は旧 proto3 JSON mapping と同一。

import type { HookMessage } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

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

/** pendingWorkDetail の最大長。生配列をそのまま運ぶとコマンド文字列等で肥大しうるため、
 * ログ用途に十分な長さで切り詰める（途中で切れて JSON として壊れてもログとしては読める） */
const PENDING_WORK_DETAIL_MAX = 4000;

/** Claude Code が stdin で渡す hook JSON から HookMessage を組み立てる。
 * 代表フィールドの取り出しと pending_work の畳み込みは Swift `hookCommand` と同一 */
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

  // Stop (done) フックの pending work シグナル。background_tasks / session_crons の
  // いずれかが残っていれば true（旧バージョンのキー欠落は count 0 = pending なし）
  const backgroundCount = Array.isArray(stdinJson.background_tasks) ? stdinJson.background_tasks.length : 0;
  const cronCount = Array.isArray(stdinJson.session_crons) ? stdinJson.session_crons.length : 0;

  // 観測ログ用: pending_work 算出元の生配列スナップショット。length だけで畳む現行判定が
  // 「完了済み entry の残留 / 長寿命 background process / 発火済み cron」で false positive に
  // なっていないかを main 側のログで観測するために運ぶ（HookMessage.pendingWorkDetail 参照）
  const pendingArrays: Record<string, unknown> = {};
  if (Array.isArray(stdinJson.background_tasks)) pendingArrays.background_tasks = stdinJson.background_tasks;
  if (Array.isArray(stdinJson.session_crons)) pendingArrays.session_crons = stdinJson.session_crons;
  const pendingWorkDetail =
    Object.keys(pendingArrays).length > 0 ? JSON.stringify(pendingArrays).slice(0, PENDING_WORK_DETAIL_MAX) : "";

  return {
    event,
    ptyId,
    lastAssistantMessage: typeof stdinJson.last_assistant_message === "string" ? stdinJson.last_assistant_message : "",
    toolName: typeof stdinJson.tool_name === "string" ? stdinJson.tool_name : "",
    toolInput: toolInputText,
    sessionId: typeof stdinJson.session_id === "string" ? stdinJson.session_id : "",
    source: typeof stdinJson.source === "string" ? stdinJson.source : "",
    pendingWork: backgroundCount + cronCount > 0,
    pendingWorkDetail,
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
