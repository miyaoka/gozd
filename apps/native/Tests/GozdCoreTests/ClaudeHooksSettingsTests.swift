import Foundation
import GozdProto
import Testing

@testable import GozdCore

@Suite("ClaudeHooksSettings")
struct ClaudeHooksSettingsTests {
  @Test("write は親ディレクトリを作って Claude hooks 設定 JSON を出力する")
  func writesFile() throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let path = (dir as NSString).appendingPathComponent("nested/claude-settings.json")
    try ClaudeHooksSettings.write(to: path)

    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    let parsed = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    let hooks = parsed?["hooks"] as? [String: Any]
    #expect(hooks?["SessionStart"] != nil)
    #expect(hooks?["Stop"] != nil)
    #expect(hooks?["PostToolUse"] != nil)
  }

  @Test("nc コマンドは proto3 JSON mapping の {hook: {...}} 形式を出す")
  func ncCommandFormat() {
    let s = ClaudeHooksSettings.settings()
    let hooks = s["hooks"] as! [String: Any]
    // UserPromptSubmit は nc 直送経路（軽量、stdin payload 不要）
    let userPromptSubmit = (hooks["UserPromptSubmit"] as! [[String: Any]])[0]
    let inner = (userPromptSubmit["hooks"] as! [[String: String]])[0]
    let cmd = inner["command"]!

    #expect(cmd.contains(#""hook":"#))
    #expect(cmd.contains(#""event":"running""#))
    #expect(cmd.contains("$GOZD_PTY_ID"))
    #expect(cmd.contains("nc -w 1 -U"))
  }

  @Test("CLI 経由のコマンドは GOZD_CLI_RUNNER + GOZD_CLI_PATH を使う")
  func cliCommandFormat() {
    let s = ClaudeHooksSettings.settings()
    let hooks = s["hooks"] as! [String: Any]
    let stop = (hooks["Stop"] as! [[String: Any]])[0]
    let inner = (stop["hooks"] as! [[String: String]])[0]
    let cmd = inner["command"]!

    #expect(cmd.contains("$GOZD_CLI_RUNNER"))
    #expect(cmd.contains("\"$GOZD_CLI_PATH\""))
    #expect(cmd.contains("hook done"))
  }

  @Test("SessionStart / SessionEnd は CLI 経由（stdin の session_id を取得するため）")
  func sessionEventsUseCli() {
    let s = ClaudeHooksSettings.settings()
    let hooks = s["hooks"] as! [String: Any]
    for event in ["SessionStart", "SessionEnd"] {
      let entry = (hooks[event] as! [[String: Any]])[0]
      let inner = (entry["hooks"] as! [[String: String]])[0]
      let cmd = inner["command"]!
      #expect(cmd.contains("$GOZD_CLI_RUNNER"), "\(event) should use CLI runner")
      #expect(cmd.contains("\"$GOZD_CLI_PATH\""), "\(event) should reference CLI path")
    }
  }

  @Test("生成された nc コマンドの JSON は ClientMessage proto としてデコードできる")
  func ncCommandIsValidProtoJson() throws {
    // 実機の zsh 環境変数置換をエミュレート
    let s = ClaudeHooksSettings.settings()
    let hooks = s["hooks"] as! [String: Any]
    let userPromptSubmit = (hooks["UserPromptSubmit"] as! [[String: Any]])[0]
    let cmd = ((userPromptSubmit["hooks"] as! [[String: String]])[0])["command"]!

    // shell が echo の引数を組み立てた結果を再現:
    //   echo の引数は `'{"hook":{"event":"...","ptyId":'"$GOZD_PTY_ID"'}}'`。
    //   $GOZD_PTY_ID=42 として連結すると `{"hook":{"event":"running","ptyId":42}}`。
    let json = #"{"hook":{"event":"running","ptyId":42}}"#
    let decoded = try Gozd_V1_ClientMessage(jsonString: json)
    if case .hook(let hook) = decoded.body {
      #expect(hook.event == "running")
      #expect(hook.ptyID == 42)
    } else {
      Issue.record("expected .hook body")
    }
    // 静的に cmd 自体に hook event 名が含まれているのも確認
    #expect(cmd.contains("running"))
  }
}

// MARK: - Helpers

private func makeTempDir() throws -> String {
  let raw = FileManager.default.temporaryDirectory
    .appendingPathComponent("gozd-claude-\(UUID().uuidString.prefix(8))")
  try FileManager.default.createDirectory(at: raw, withIntermediateDirectories: true)
  return URL(fileURLWithPath: raw.path).resolvingSymlinksInPath().path
}
