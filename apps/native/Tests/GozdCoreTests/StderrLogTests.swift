import Foundation
import Testing

@testable import GozdCore

@Suite("StderrLog.escapeControl")
struct StderrLogTests {
  @Test("ASCII printable / multi-byte UTF-8 はそのまま透過する")
  func passesThroughPrintableAndMultiByte() {
    #expect(StderrLog.escapeControl("hello world") == "hello world")
    #expect(StderrLog.escapeControl("日本語テスト") == "日本語テスト")
    #expect(StderrLog.escapeControl("path=/var/folders/_test") == "path=/var/folders/_test")
    // 各種 punctuation は printable ASCII
    #expect(StderrLog.escapeControl("a=[b] c=(d) e={f}") == "a=[b] c=(d) e={f}")
  }

  @Test("CR / LF / TAB / NUL を \\xNN に escape する")
  func escapesCommonControlChars() {
    #expect(StderrLog.escapeControl("line1\nline2") == "line1\\x0Aline2")
    #expect(StderrLog.escapeControl("line1\rline2") == "line1\\x0Dline2")
    #expect(StderrLog.escapeControl("col1\tcol2") == "col1\\x09col2")
    #expect(StderrLog.escapeControl("a\u{0000}b") == "a\\x00b")
  }

  @Test("DEL (0x7F) も escape 対象")
  func escapesDel() {
    #expect(StderrLog.escapeControl("a\u{007F}b") == "a\\x7Fb")
  }

  @Test("BEL (0x07) 等のあまり使われない C0 も含めて escape")
  func escapesAllC0() {
    // BEL, BS, VT, FF, ESC を網羅。0x00-0x1F 全域を helper が見ていることを確認する。
    #expect(StderrLog.escapeControl("\u{0007}") == "\\x07")
    #expect(StderrLog.escapeControl("\u{0008}") == "\\x08")
    #expect(StderrLog.escapeControl("\u{000B}") == "\\x0B")
    #expect(StderrLog.escapeControl("\u{000C}") == "\\x0C")
    #expect(StderrLog.escapeControl("\u{001B}") == "\\x1B")
  }

  @Test("空文字列は空文字列のまま")
  func emptyStringPassesThrough() {
    #expect(StderrLog.escapeControl("") == "")
  }

  @Test("call site 例: error 文字列に混入した改行を escape する")
  func realisticErrorWithEmbeddedNewline() {
    // call site 規約 (素 interpolation) を保ちながら、helper 経路で 1 行性が守られることを確認。
    let raw = "decode failed: Error Domain=Foo Code=1 \"line1\nline2\""
    let escaped = StderrLog.escapeControl(raw)
    #expect(!escaped.contains("\n"))
    #expect(escaped.contains("\\x0A"))
  }
}
