import Foundation

// Claude Code の `--settings` で読み込まれる hooks 設定 JSON を生成する。
//
// 設計判断:
//
// 1. **Claude が消費する外部 schema** なので gozd の proto SSOT には乗らない。
//    JSONSerialization で固定構造を組み立てる。
//
// 2. **2 経路の hook command**:
//    - `nc -w 1 -U $GOZD_SOCKET_PATH`: 軽量、固定 JSON 直送。stdin payload 不要なイベント用
//    - `$GOZD_CLI_RUNNER "$GOZD_CLI_PATH" hook <event>`: CLI 経由、stdin の Claude 側 hook JSON を
//      パースして rich payload を含む HookMessage を作る。発火頻度の低い rich event 用
//
// 3. **wire 形式は proto3 JSON mapping**: `{"hook":{"event":"<name>","ptyId":<n>}}` の形で
//    `ClientMessage` の hook oneof をそのまま埋め込む。これで SocketServer の receive 側を
//    proto デコーダに統一できる。
public enum ClaudeHooksSettings {
  /// 設定 JSON ファイルを `path` に書き出す。
  public static func write(to path: String) throws {
    let json = try JSONSerialization.data(
      withJSONObject: settings(),
      options: [.prettyPrinted, .sortedKeys]
    )
    let withTrailingNewline = json + Data("\n".utf8)
    try ensureDirectory(forFile: path)
    try withTrailingNewline.write(to: URL(fileURLWithPath: path))
  }

  /// JSON にする前の dictionary を返す（テスト用）。
  static func settings() -> [String: Any] {
    return [
      "hooks": [
        "SessionStart": [
          ["hooks": [["type": "command", "command": ncCommand("session-start")]]]
        ],
        "SessionEnd": [
          ["hooks": [["type": "command", "command": ncCommand("session-end")]]]
        ],
        "UserPromptSubmit": [
          ["hooks": [["type": "command", "command": ncCommand("running")]]]
        ],
        "Stop": [
          ["hooks": [["type": "command", "command": cliCommand("done")]]]
        ],
        "StopFailure": [
          ["hooks": [["type": "command", "command": cliCommand("stop-failure")]]]
        ],
        "PermissionRequest": [
          [
            "matcher": "*",
            "hooks": [["type": "command", "command": cliCommand("needs-input")]],
          ]
        ],
        "PostToolUse": [
          [
            "matcher": "*",
            "hooks": [["type": "command", "command": ncCommand("tool-done")]],
          ]
        ],
        "PostToolUseFailure": [
          [
            "matcher": "*",
            "hooks": [["type": "command", "command": cliCommand("tool-failure")]],
          ]
        ],
      ]
    ]
  }
}

// MARK: - private helpers

private func ncCommand(_ event: String) -> String {
  // proto3 JSON mapping: `{"hook":{"event":"<event>","ptyId":<id>}}`
  // GOZD_PTY_ID は zsh init で各 PTY に注入される（apps/desktop/zsh/.zshrc 相当）。
  return
    "echo '{\"hook\":{\"event\":\"\(event)\",\"ptyId\":'\"$GOZD_PTY_ID\"'}}' | nc -w 1 -U \"$GOZD_SOCKET_PATH\""
}

private func cliCommand(_ event: String) -> String {
  return "$GOZD_CLI_RUNNER \"$GOZD_CLI_PATH\" hook \(event)"
}

private func ensureDirectory(forFile path: String) throws {
  let dir = (path as NSString).deletingLastPathComponent
  try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
}
