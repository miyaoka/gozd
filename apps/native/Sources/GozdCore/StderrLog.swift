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
/// C0 制御文字 (U+0000-U+001F) と DEL (U+007F) を `\xNN` 形式に escape する。
/// multi-byte UTF-8 構成バイト (0x80-0xFF) は触らない (非英語 locale の文字列を
/// そのまま流す)。escape 後の末尾に改行を 1 つだけ付与する。call site は改行を
/// message に含めない。
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
    let line = "[\(tag)] \(escapeControl(message))\n"
    FileHandle.standardError.write(Data(line.utf8))
  }

  /// C0 制御文字と DEL を `\xNN` に escape する。multi-byte UTF-8 構成バイトは保持する。
  /// helper 内部で完結する unit。test からも検証する。
  internal static func escapeControl(_ s: String) -> String {
    var out = ""
    out.reserveCapacity(s.unicodeScalars.count)
    for scalar in s.unicodeScalars {
      let v = scalar.value
      if v < 0x20 || v == 0x7F {
        out.append(String(format: "\\x%02X", v))
      } else {
        out.unicodeScalars.append(scalar)
      }
    }
    return out
  }
}
