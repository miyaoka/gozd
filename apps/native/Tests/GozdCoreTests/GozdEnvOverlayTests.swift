import Foundation
import Testing

@testable import GozdCore

@Suite("GozdEnvOverlay")
struct GozdEnvOverlayTests {
  private func makeOverlay() -> GozdEnvOverlay {
    GozdEnvOverlay(
      socketPath: "/tmp/gozd-dev.sock",
      cliPath: "/proj/apps/cli/src/index.ts",
      cliRunner: "bun",
      claudeSettingsPath: "/tmp/gozd-dev-claude-settings.json",
      zdotdir: "/proj/apps/desktop/zsh",
      userHome: "/Users/test"
    )
  }

  @Test("ptyId と固定 GOZD_* 変数が注入される")
  func injectsGozdVars() {
    let env = makeOverlay().merged(into: [:], ptyId: 42)
    #expect(env["GOZD_PTY_ID"] == "42")
    #expect(env["GOZD_SOCKET_PATH"] == "/tmp/gozd-dev.sock")
    #expect(env["GOZD_CLI_PATH"] == "/proj/apps/cli/src/index.ts")
    #expect(env["GOZD_CLI_RUNNER"] == "bun")
    #expect(env["GOZD_CLAUDE_SETTINGS_PATH"] == "/tmp/gozd-dev-claude-settings.json")
  }

  @Test("ZDOTDIR は gozd 側に切替、ユーザーの ZDOTDIR は GOZD_ORIG_ZDOTDIR に退避される")
  func zdotdirChain() {
    let env = makeOverlay().merged(
      into: ["ZDOTDIR": "/Users/test/dotfiles/zsh"], ptyId: 1)
    #expect(env["ZDOTDIR"] == "/proj/apps/desktop/zsh")
    #expect(env["GOZD_ZDOTDIR"] == "/proj/apps/desktop/zsh")
    #expect(env["GOZD_ORIG_ZDOTDIR"] == "/Users/test/dotfiles/zsh")
  }

  @Test("入力 env に ZDOTDIR が無ければ userHome をフォールバックに退避する")
  func zdotdirFallbackToHome() {
    let env = makeOverlay().merged(into: [:], ptyId: 1)
    #expect(env["GOZD_ORIG_ZDOTDIR"] != nil)
    // ProcessInfo の ZDOTDIR か userHome のどちらか。プロセス側に ZDOTDIR が
    // 設定されていない前提のテスト環境なら userHome になる。
    let allowed: Set<String> = [
      "/Users/test", ProcessInfo.processInfo.environment["ZDOTDIR"] ?? "",
    ]
    #expect(allowed.contains(env["GOZD_ORIG_ZDOTDIR"]!))
  }

  @Test("renderer 側で渡された値は親 env / overlay デフォルトより優先される")
  func rendererTakesPrecedence() {
    let env = makeOverlay().merged(
      into: [
        "TERM": "xterm-256color",
        "TERM_PROGRAM": "user-set",
        "HOME": "/custom/home",
      ], ptyId: 1)
    #expect(env["TERM"] == "xterm-256color")
    #expect(env["TERM_PROGRAM"] == "user-set")
    #expect(env["HOME"] == "/custom/home")
  }

  @Test("TERM_PROGRAM / FORCE_HYPERLINK は未設定時に gozd デフォルトで埋まる")
  func fillsGozdDefaults() {
    let env = makeOverlay().merged(into: [:], ptyId: 1)
    #expect(env["TERM_PROGRAM"] == "gozd")
    #expect(env["FORCE_HYPERLINK"] == "1")
    // HOME は親プロセスから継承されるため必ず存在する
    #expect(env["HOME"] != nil)
  }

  @Test("親プロセスの env が base として継承される")
  func inheritsParentEnv() {
    // setenv で親プロセスに任意の値を入れて継承を確認
    let key = "GOZD_TEST_INHERIT_\(UUID().uuidString.prefix(8))"
    setenv(key, "from-parent", 1)
    defer { unsetenv(key) }

    let env = makeOverlay().merged(into: [:], ptyId: 1)
    #expect(env[key] == "from-parent")
  }

  @Test("stripped keys（GOZD_DEV_PROJECT_ROOT 等）は子に継承されない")
  func stripsInternalDevFlags() {
    setenv("GOZD_DEV_PROJECT_ROOT", "/should/not/leak", 1)
    setenv("GOZD_DEV_VITE_URL", "http://leaked", 1)
    defer {
      unsetenv("GOZD_DEV_PROJECT_ROOT")
      unsetenv("GOZD_DEV_VITE_URL")
    }

    let env = makeOverlay().merged(into: [:], ptyId: 1)
    #expect(env["GOZD_DEV_PROJECT_ROOT"] == nil)
    #expect(env["GOZD_DEV_VITE_URL"] == nil)
  }
}
