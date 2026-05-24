import Foundation

/// 観察ログ (stderr) の SSOT helper。
///
/// dispatcher / store / hook ハンドラなどから 1 行の ad-hoc 観察ログを書き出す。
/// 既存の `[handler-or-store-name] message` 規約を踏襲しつつ、call site から
/// sanitize 判断を消すために helper 側で escape を引き受ける。
///
/// ## なぜ helper 集約か
///
/// 以前の規約は「素埋め込み + source 側 sanitize」を併記していたが、両者は両立
/// しない (素埋め込みの見た目を保つと sanitize 関数呼びが見えなくなり、レビューで
/// 違反を検出できない)。helper を経由させると、call site は素の string
/// interpolation を書き、改行 / 制御文字の escape は helper の責任で必ず実行される。
/// SSOT を「規約条文」から「実行コード」に移すことで、違反が構造的に発生しなくなる。
///
/// ## escape 仕様
///
/// 以下を `\xNN` / `\uNNNN` 形式に escape する:
///
/// - C0 制御文字 (U+0000-U+001F) と DEL (U+007F) → `\xNN`
/// - C1 制御文字 (U+0080-U+009F)、NEL (U+0085 は C1 と重複) → `\xNN`
/// - LINE SEPARATOR (U+2028) / PARAGRAPH SEPARATOR (U+2029) → `\uNNNN`
///
/// 通常の multi-byte UTF-8 文字 (U+00A0 以降の表示可能文字、`Ω` `日本語` 等) は
/// 触らない (非英語 locale の strerror / path を温存する)。
///
/// U+2028 / U+2029 / NEL は Unicode 上「行区切り」として定義された character で、
/// 一部の表示系 (JavaScript console / 一部 terminal) でログ行を物理的に割る経路を
/// 持つ。観察ログの 1 行性 (grep / awk / Console.app の event 単位処理) を Unicode
/// 表示単位でも壊さないため escape 対象に含める。
///
/// ## byte-level 1 行性 (write の atomicity)
///
/// 観察ログ helper は複数の actor / `@MainActor` から並列発火する。POSIX `write(2)`
/// は `PIPE_BUF` (Darwin で 512 byte) を超える書き込みの atomicity を保証しないため、
/// 長い 1 行 (path / executable / siblings 配列の interpolation 等) が並列発火で
/// byte 単位に混線する経路がある。`PTYTrace.swift` が同じ問題を NSLock で潰した
/// 先例があり、本 helper も `lock` で write 全体を serialize する。call site は
/// 同期 / 非同期どちらからでもこの API を素直に呼べばよい (lock の存在は隠蔽)。
///
/// ## 対象外
///
/// trace 系統 (`[PTY-TRACE ...]` / `[TEST-TRACE ...]`) は自前の format を持ち、
/// 1 行性を別途保証している (`PTYTrace.swift` 参照)。本 helper は経由しない。
public enum StderrLog {
  /// `[tag] message` を stderr に 1 行書く。
  ///
  /// - Parameters:
  ///   - tag: handler 関数名 (`handlePtySpawn`) または store / module 名 (`ClaudeSessionStore`)。
  ///     bracket は helper が付ける。call site では中身のみ渡す。
  ///   - message: 任意の string。制御文字は helper が escape する。call site で sanitize
  ///     する必要は無い。
  public static func write(tag: String, _ message: String) {
    writeImpl(tag: tag, message, to: FileHandle.standardError)
  }

  /// test から FileHandle を差し替えて output を verify するために切り出した本体。
  /// production は `write(tag:_:)` 経由でのみ呼ぶ (FileHandle.standardError を渡す)。
  ///
  /// FileHandle parameter を最終 sink にすることで、test は `Pipe()` の write 側を
  /// 渡して output を read back できる。`dup2(STDERR_FILENO, ...)` で global stderr を
  /// 乗っ取ると Swift Testing の並列 runner が出す `◇ Test started` 等の stderr 出力と
  /// 混線するため、handle injection で test isolation を担保する。
  internal static func writeImpl(tag: String, _ message: String, to handle: FileHandle) {
    let line = formatLine(tag: tag, message)
    lock.lock()
    defer { lock.unlock() }
    handle.write(Data(line.utf8))
  }

  /// `write` が stderr に渡す string を組み立てる。`[tag] message\n` の format を
  /// SSOT として固定し、test から output 形式を assert できるよう公開する (`internal`)。
  ///
  /// `write` の責務は (format) + (escape) + (lock + stderr write) の 3 つだが、
  /// 後段は副作用なので format 部分を pure function として切り出してテスト可能にする。
  internal static func formatLine(tag: String, _ message: String) -> String {
    return "[\(tag)] \(escapeControl(message))\n"
  }

  /// 制御文字と行区切り Unicode を escape する。詳細は型の docstring 参照。
  /// helper 内部で完結する unit。test からも検証する。
  internal static func escapeControl(_ s: String) -> String {
    var out = ""
    out.reserveCapacity(s.unicodeScalars.count)
    for scalar in s.unicodeScalars {
      let v = scalar.value
      if v < 0x20 || v == 0x7F || (0x80...0x9F).contains(v) {
        out.append(String(format: "\\x%02X", v))
      } else if v == 0x2028 || v == 0x2029 {
        out.append(String(format: "\\u%04X", v))
      } else {
        out.unicodeScalars.append(scalar)
      }
    }
    return out
  }

  /// stderr write の byte-level atomicity を守るための serialization lock。
  /// 並列 actor / `@MainActor` 経路からの write が PIPE_BUF (Darwin で 512 byte) を
  /// 超える場合に POSIX が保証しない atomic 性を、process 内で補強する。
  private static let lock = NSLock()
}
