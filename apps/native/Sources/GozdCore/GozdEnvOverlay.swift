import Foundation

// PTY spawn 時の環境変数を構築する。
//
// 設計方針: 親プロセス（gozd Swift app）の env を **base として全継承** し、
// 上に renderer 指定の env、上に gozd overlay を順に重ねる。
// 一般的なターミナルエミュレータ（iTerm2 / Terminal.app / Alacritty 等）に倣う。
//
// 「allow-list で必要な変数だけを継承する」設計は workaround 化しやすい:
// USER / LOGNAME を解決すると次は HOMEBREW_*、その次は XDG_* と、
// ツールチェーンが追加されるたびに list を継ぎ足す運用負債になる。
// 全継承 + 明示的に削るキーを deny-list で管理する方が保守可能。
//
// gozd overlay が最後に上書きするキー:
//   - GOZD_PTY_ID: spawn ごとに採番される ID
//   - GOZD_SOCKET_PATH / GOZD_CLI_PATH / GOZD_CLI_RUNNER /
//     GOZD_CLAUDE_SETTINGS_PATH: hook コマンド経路の解決
//   - GOZD_ZDOTDIR / GOZD_ORIG_ZDOTDIR / ZDOTDIR: zsh 初期化チェーン
//   - TERM_PROGRAM=gozd / FORCE_HYPERLINK=1: ターミナル識別と OSC 8 許可
//   - HOME: 親プロセスの値を尊重（通常は親の HOME が常に正しい）
//
// 親プロセスから継承したくないキー（GOZD_DEV_* 等の内部フラグ）は
// `STRIPPED_KEYS` で明示的に除去する。
public struct GozdEnvOverlay: Sendable {
  public let socketPath: String
  public let cliPath: String
  public let cliRunner: String
  public let claudeSettingsPath: String
  public let zdotdir: String
  public let userHome: String

  /// PTY 子プロセスに継承させない親プロセス由来のキー。
  /// gozd Swift app が dev モード判定のために持つ内部フラグ等は子に漏らさない。
  private static let strippedKeys: Set<String> = [
    "GOZD_DEV_PROJECT_ROOT",
    "GOZD_DEV_VITE_URL",
    "ZDOTDIR",  // overlay 側で gozd dir に上書きするため、誤った状態が混ざらないよう除去
  ]

  /// 親プロセス env から「子に漏らしてはいけない gozd 起源キー」を除去する。
  /// PTY spawn と CLI 解決 (`CommandResolver`) の両者で同じ deny-list を使う SSOT。
  /// PTY 子では merged() の上書きで覆われるキーもあるが、CLI 解決では sanitize 後に
  /// overlay を被せないため、`strippedKeys` がそのまま除去対象になる。
  public static func sanitizeParentEnv(_ env: [String: String]) -> [String: String] {
    var result = env
    for key in strippedKeys { result.removeValue(forKey: key) }
    return result
  }

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

  /// 親プロセス env を base に renderer env と gozd overlay を重ねた最終形を返す。
  /// 優先順（後勝ち）: 親 env → renderer env → gozd overlay
  public func merged(into rendererEnv: [String: String], ptyId: UInt32) -> [String: String] {
    let parentEnv = ProcessInfo.processInfo.environment

    // 1. 親 env を base に。strippedKeys は除去
    var result = GozdEnvOverlay.sanitizeParentEnv(parentEnv)

    // 2. renderer 指定の env を上書き
    for (k, v) in rendererEnv { result[k] = v }

    // 3. gozd overlay を上書き（renderer / 親より優先）
    result["GOZD_PTY_ID"] = String(ptyId)
    result["GOZD_SOCKET_PATH"] = socketPath
    result["GOZD_CLI_PATH"] = cliPath
    result["GOZD_CLI_RUNNER"] = cliRunner
    result["GOZD_CLAUDE_SETTINGS_PATH"] = claudeSettingsPath

    // ZDOTDIR チェーン: 元値（親 or renderer 指定）を退避してから gozd 側に切替
    let originalZdotdir =
      rendererEnv["ZDOTDIR"]
      ?? parentEnv["ZDOTDIR"]
      ?? userHome
    result["GOZD_ORIG_ZDOTDIR"] = originalZdotdir
    result["GOZD_ZDOTDIR"] = zdotdir
    result["ZDOTDIR"] = zdotdir

    // 親 / renderer に値があればそちら優先、無ければ gozd デフォルト
    if result["TERM_PROGRAM"] == nil { result["TERM_PROGRAM"] = "gozd" }
    if result["FORCE_HYPERLINK"] == nil { result["FORCE_HYPERLINK"] = "1" }
    if result["HOME"] == nil { result["HOME"] = userHome }

    return result
  }
}
