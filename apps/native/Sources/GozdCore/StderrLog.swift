import Foundation

/// 観察ログ (stderr) の 1 行書き出し helper。
///
/// dispatcher / store / hook ハンドラの ad-hoc 観察ログを `[tag] message\n` の format で
/// 出力する。format / escape / serialization を helper 側に閉じ込め、call site は素の
/// string interpolation で値を渡す。
///
/// ## format
///
/// `[tag] <escaped message>\n`。bracket と末尾 `\n` は helper が付ける。
///
/// ## escape 仕様
///
/// 観察ログの 1 行性 (grep / awk / Console.app の event 単位処理) を Unicode 表示単位
/// でも壊さないため、以下の scalar を `\xNN` / `\uNNNN` 形式に escape する:
///
/// - C0 制御文字 (U+0000-U+001F) と DEL (U+007F) → `\xNN`
/// - C1 制御文字 (U+0080-U+009F、NEL U+0085 を含む) → `\xNN`
/// - LINE SEPARATOR (U+2028) / PARAGRAPH SEPARATOR (U+2029) → `\uNNNN`
///
/// U+00A0 以降の通常 multi-byte UTF-8 (表示可能文字、非英語 locale の strerror / path 等)
/// は escape しない。
///
/// ## byte-level 1 行性
///
/// 複数 actor / `@MainActor` 経路からの並列発火を NSLock で serialize する。POSIX
/// `write(2)` は `PIPE_BUF` (Darwin 512 byte) 超で atomic 性を保証しないため、長い 1 行
/// (path / executable / siblings 配列等の interpolation) が byte 単位で混線する経路を
/// 塞ぐ。call site は同期 / 非同期どちらからでもこの API を呼べる。
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

  /// 出力先 FileHandle を inject 可能にした本体。production は `write(tag:_:)` 経由で
  /// `FileHandle.standardError` を渡す。test は `Pipe()` の write 側を渡して
  /// output を read back する。
  internal static func writeImpl(tag: String, _ message: String, to handle: FileHandle) {
    let line = formatLine(tag: tag, message)
    lock.lock()
    defer { lock.unlock() }
    handle.write(Data(line.utf8))
  }

  /// `[tag] <escaped message>\n` を組み立てる pure function。`writeImpl` から呼ばれ、
  /// test からも format 単体を assert できる seam。
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
