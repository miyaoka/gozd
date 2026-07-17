// Claude Code の `--settings` で読み込まれる hooks 設定 JSON を生成する。
// Swift 版 `Claude/ClaudeHooksSettings.swift` の対応物。
//
// - Claude が消費する外部 schema なので gozd の型 SSOT (@gozd/rpc) には乗らない。固定構造を組む
// - 2 経路の hook command:
//   - `nc -w 1 -U $GOZD_SOCKET_PATH`: 軽量、固定 JSON 直送。発火頻度の高いイベント用
//   - `"$GOZD_CLI_PATH" hook <event>`: CLI 経由。stdin の Claude hook JSON をパースして
//     rich payload（session_id / last_assistant_message 等）を含む HookMessage を作る
// - wire 形式は ClientMessage の JSON: `{"hook":{"event":"<name>","ptyId":<n>}}` の形で
//   固定 JSON を埋め込み、SocketServer の receive 側 (parseClientMessage) に統一する

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function ncCommand(event: string): string {
  // ClientMessage の JSON: `{"hook":{"event":"<event>","ptyId":<id>}}`
  // GOZD_PTY_ID は PTY spawn 時の env overlay で各 PTY に注入される
  return `echo '{"hook":{"event":"${event}","ptyId":'"$GOZD_PTY_ID"'}}' | nc -w 1 -U "$GOZD_SOCKET_PATH"`;
}

function cliCommand(event: string): string {
  return `"$GOZD_CLI_PATH" hook ${event}`;
}

/** JSON にする前の構造を返す（テスト用に公開） */
export function claudeHooksSettings(): Record<string, unknown> {
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: cliCommand("session-start") }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: cliCommand("session-end") }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: ncCommand("running") }] }],
      Stop: [{ hooks: [{ type: "command", command: cliCommand("done") }] }],
      StopFailure: [{ hooks: [{ type: "command", command: cliCommand("stop-failure") }] }],
      PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command: cliCommand("needs-input") }] }],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: ncCommand("tool-done") }] }],
      PostToolUseFailure: [{ matcher: "*", hooks: [{ type: "command", command: ncCommand("tool-failure") }] }],
      // 子エージェント（subagent / teammate）のライフサイクル。teammate は idle 化しても
      // Stop の background_tasks に status "running" のまま残るため、稼働中/idle の判定は
      // この 3 hook を情報源に renderer 側の台帳で行う（orca の roster と同じ構成）。
      // agent_id / teammate_name を payload に載せる必要があるため CLI 経由
      SubagentStart: [{ hooks: [{ type: "command", command: cliCommand("subagent-start") }] }],
      SubagentStop: [{ hooks: [{ type: "command", command: cliCommand("subagent-stop") }] }],
      TeammateIdle: [{ hooks: [{ type: "command", command: cliCommand("teammate-idle") }] }],
    },
  };
}

/** 設定 JSON ファイルを path に書き出す（Swift 版と同じく sorted keys + 末尾改行） */
export function writeClaudeHooksSettings(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(claudeHooksSettings(), sortKeysReplacer, 2)}\n`);
}

/** JSON.stringify で Swift の .sortedKeys と同じくキーを辞書順に出す */
function sortKeysReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = (value as Record<string, unknown>)[key];
  }
  return sorted;
}
