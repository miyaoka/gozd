// ClaudeHooksSettings のテスト。Swift 版 `ClaudeHooksSettingsTests.swift` のケースを
// 対で移植し、hook command の 2 経路（nc 直送 / CLI 経由）と wire 形式
// （ClientMessage の JSON 1 行）の契約を固定する。

import type { ClientMessage } from "@gozd/rpc";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeHooksSettings, writeClaudeHooksSettings } from "./claudeHooksSettings";

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string }>;
}

function commandFor(event: string): string {
  const hooks = claudeHooksSettings().hooks as Record<string, HookEntry[]>;
  const [entry] = hooks[event] ?? [];
  const [hook] = entry?.hooks ?? [];
  if (hook === undefined) throw new Error(`no hook command for ${event}`);
  return hook.command;
}

describe("ClaudeHooksSettings", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("write は親ディレクトリを作って Claude hooks 設定 JSON を出力する", () => {
    const dir = mkdtempSync(join(tmpdir(), "gozd-hooks-settings-test-"));
    tempDirs.push(dir);
    const path = join(dir, "nested", "settings.json");
    writeClaudeHooksSettings(path);
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(content) as { hooks: Record<string, unknown> };
    expect(Object.keys(parsed.hooks).toSorted()).toEqual([
      "PermissionRequest",
      "PostToolUse",
      "PostToolUseFailure",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "StopFailure",
      "SubagentStart",
      "SubagentStop",
      "TeammateIdle",
      "UserPromptSubmit",
    ]);
  });

  test("nc コマンドは ClientMessage の {hook: {...}} 形式を出す", () => {
    const command = commandFor("UserPromptSubmit");
    expect(command).toContain('{"hook":{"event":"running","ptyId":');
    expect(command).toContain('nc -w 1 -U "$GOZD_SOCKET_PATH"');
    expect(command).toContain('"$GOZD_PTY_ID"');
  });

  test("CLI 経由のコマンドは GOZD_CLI_PATH を直接実行する", () => {
    expect(commandFor("Stop")).toBe('"$GOZD_CLI_PATH" hook done');
    expect(commandFor("PermissionRequest")).toBe('"$GOZD_CLI_PATH" hook needs-input');
    expect(commandFor("StopFailure")).toBe('"$GOZD_CLI_PATH" hook stop-failure');
  });

  test("SessionStart / SessionEnd は CLI 経由（stdin の session_id を取得するため）", () => {
    expect(commandFor("SessionStart")).toBe('"$GOZD_CLI_PATH" hook session-start');
    expect(commandFor("SessionEnd")).toBe('"$GOZD_CLI_PATH" hook session-end');
  });

  test("子エージェント lifecycle hook は CLI 経由（stdin の agent_id / teammate_name を取得するため）", () => {
    expect(commandFor("SubagentStart")).toBe('"$GOZD_CLI_PATH" hook subagent-start');
    expect(commandFor("SubagentStop")).toBe('"$GOZD_CLI_PATH" hook subagent-stop');
    expect(commandFor("TeammateIdle")).toBe('"$GOZD_CLI_PATH" hook teammate-idle');
  });

  test("生成された nc コマンドの JSON は ClientMessage としてデコードできる", () => {
    const command = commandFor("PostToolUse");
    // シェル変数展開 `'"$GOZD_PTY_ID"'` を数値に置換して、実際に流れる JSON を再現する
    const jsonPart = command.slice(command.indexOf("'") + 1, command.lastIndexOf("' | nc"));
    const substituted = jsonPart.replace(`'"$GOZD_PTY_ID"'`, "42");
    const msg = JSON.parse(substituted) as ClientMessage;
    expect(msg.hook?.event).toBe("tool-done");
    expect(msg.hook?.ptyId).toBe(42);
  });
});
