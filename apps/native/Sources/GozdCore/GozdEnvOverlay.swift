import Foundation

// PTY spawn 時に注入する gozd 固有の環境変数を構築する。
//
// architecture.md §「PTY と環境変数」の規約に対応:
//   - GOZD_PTY_ID: spawn ごとに採番される ID（PTYRegistry が ptyId を確定後に注入）
//   - GOZD_SOCKET_PATH / GOZD_CLI_PATH / GOZD_CLI_RUNNER /
//     GOZD_CLAUDE_SETTINGS_PATH: hook コマンド経路の解決に使う
//   - GOZD_ZDOTDIR / GOZD_ORIG_ZDOTDIR / ZDOTDIR: zsh 初期化チェーン用
//   - TERM_PROGRAM=gozd / FORCE_HYPERLINK=1: ターミナル識別と OSC 8 許可
//   - HOME: renderer が渡さなくても zsh が必要とするため補完
//
// renderer から渡された env と merge する。renderer 側の値（TERM 等）は
// 上書きせず、未設定キーのみを overlay が埋める。
public struct GozdEnvOverlay: Sendable {
  public let socketPath: String
  public let cliPath: String
  public let cliRunner: String
  public let claudeSettingsPath: String
  public let zdotdir: String
  public let userHome: String

  public init(
    socketPath: String,
    cliPath: String,
    cliRunner: String,
    claudeSettingsPath: String,
    zdotdir: String,
    userHome: String
  ) {
    self.socketPath = socketPath
    self.cliPath = cliPath
    self.cliRunner = cliRunner
    self.claudeSettingsPath = claudeSettingsPath
    self.zdotdir = zdotdir
    self.userHome = userHome
  }

  /// renderer から渡された env に gozd overlay を merge する。
  /// 既存値を尊重しつつ、未設定の必須キーを補完する。
  public func merged(into env: [String: String], ptyId: UInt32) -> [String: String] {
    var result = env

    // 識別子・経路系（renderer 側で用意できないため必ず注入する）
    result["GOZD_PTY_ID"] = String(ptyId)
    result["GOZD_SOCKET_PATH"] = socketPath
    result["GOZD_CLI_PATH"] = cliPath
    result["GOZD_CLI_RUNNER"] = cliRunner
    result["GOZD_CLAUDE_SETTINGS_PATH"] = claudeSettingsPath

    // zsh 初期化チェーン: ユーザーの ZDOTDIR を退避してから gozd 側に切替
    let originalZdotdir =
      env["ZDOTDIR"]
      ?? ProcessInfo.processInfo.environment["ZDOTDIR"]
      ?? userHome
    result["GOZD_ORIG_ZDOTDIR"] = originalZdotdir
    result["GOZD_ZDOTDIR"] = zdotdir
    result["ZDOTDIR"] = zdotdir

    // 未設定なら補完（renderer 側で渡されていれば上書きしない）
    if result["HOME"] == nil { result["HOME"] = userHome }
    if result["TERM_PROGRAM"] == nil { result["TERM_PROGRAM"] = "gozd" }
    if result["FORCE_HYPERLINK"] == nil { result["FORCE_HYPERLINK"] = "1" }

    // POSIX 標準の identity 系を親プロセスから継承して補完する。
    // 欠落していると Starship / oh-my-zsh 等が「user が異なる」「SSH 的」と
    // 誤判定して username を prompt に出す。`USER` / `LOGNAME` / `SHELL` /
    // `LC_*` 系 / `TERM_SESSION_ID` 等を引き継ぐ。
    let parentEnv = ProcessInfo.processInfo.environment
    let inherit = [
      "USER", "LOGNAME", "SHELL", "TZ",
      "LC_ALL", "LC_CTYPE", "LC_COLLATE", "LC_MESSAGES", "LC_NUMERIC",
      "LC_TIME", "LC_MONETARY",
    ]
    for key in inherit where result[key] == nil {
      if let v = parentEnv[key], !v.isEmpty { result[key] = v }
    }

    return result
  }
}
