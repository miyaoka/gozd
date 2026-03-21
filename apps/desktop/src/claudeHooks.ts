import fs from "node:fs";
import { tryCatch } from "@gozd/shared";

/** hooks 設定ファイルを生成する。nc で直接ソケットに通知する */
export function generateClaudeSettings(settingsPath: string): void {
  /** nc で固定 JSON を直接送信（軽量。stdin のデータは不要なイベント用） */
  const hookCommand = (event: string) =>
    `echo '{"type":"hook","event":"${event}","payload":{"ptyId":'"$GOZD_PTY_ID"'}}' | nc -w 1 -U "$GOZD_SOCKET_PATH"`;

  /** CLI 経由で stdin の JSON をパースして送信（stdin データが必要なイベント用） */
  const hookCommandViaCli = (event: string) => `$GOZD_CLI_RUNNER "$GOZD_CLI_PATH" hook ${event}`;

  const settings = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: hookCommand("session-start") }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: hookCommand("session-end") }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand("running") }] }],
      Stop: [{ hooks: [{ type: "command", command: hookCommandViaCli("done") }] }],
      StopFailure: [{ hooks: [{ type: "command", command: hookCommandViaCli("stop-failure") }] }],
      PermissionRequest: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: hookCommandViaCli("needs-input") }],
        },
      ],
      PostToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: hookCommand("tool-done") }],
        },
      ],
      PostToolUseFailure: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: hookCommandViaCli("tool-failure") }],
        },
      ],
    },
  };

  const writeResult = tryCatch(() =>
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n"),
  );
  if (!writeResult.ok) {
    console.error("[gozd] Claude hooks 設定の書き出しに失敗:", writeResult.error.message);
  }
}
