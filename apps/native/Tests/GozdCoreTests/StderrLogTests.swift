import Foundation
import Testing

@testable import GozdCore

@Suite("StderrLog.escapeControl")
struct StderrLogEscapeTests {
  @Test("ASCII printable / multi-byte UTF-8 はそのまま透過する")
  func passesThroughPrintableAndMultiByte() {
    #expect(StderrLog.escapeControl("hello world") == "hello world")
    #expect(StderrLog.escapeControl("日本語テスト") == "日本語テスト")
    #expect(StderrLog.escapeControl("path=/var/folders/_test") == "path=/var/folders/_test")
    // 各種 punctuation は printable ASCII
    #expect(StderrLog.escapeControl("a=[b] c=(d) e={f}") == "a=[b] c=(d) e={f}")
    // U+00A0 以降の通常 multi-byte (¿ Ω) は escape しない
    #expect(StderrLog.escapeControl("¿Ω") == "¿Ω")
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

  @Test("C1 制御文字 (NEL を含む) も escape する")
  func escapesC1ControlChars() {
    // NEL (U+0085) は一部 terminal で行区切りに解釈されるため escape
    #expect(StderrLog.escapeControl("a\u{0085}b") == "a\\x85b")
    // C1 全域 (U+0080-U+009F) を escape する
    #expect(StderrLog.escapeControl("\u{0080}") == "\\x80")
    #expect(StderrLog.escapeControl("\u{009F}") == "\\x9F")
  }

  @Test("Unicode line/paragraph separator を \\uNNNN に escape する")
  func escapesUnicodeLineSeparators() {
    // U+2028 / U+2029 は Unicode 行区切り。JavaScript console や一部 terminal で
    // 物理的に行を割る経路があるため escape して観察ログの 1 行性を守る。
    #expect(StderrLog.escapeControl("a\u{2028}b") == "a\\u2028b")
    #expect(StderrLog.escapeControl("a\u{2029}b") == "a\\u2029b")
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

@Suite("StderrLog.formatLine")
struct StderrLogFormatTests {
  @Test("format は [tag] message\\n で固定する")
  func basicFormat() {
    #expect(StderrLog.formatLine(tag: "handlePtySpawn", "pty.spawn failed") == "[handlePtySpawn] pty.spawn failed\n")
  }

  @Test("format は escape 適用後の message を埋め込む")
  func formatAppliesEscape() {
    let line = StderrLog.formatLine(tag: "TaskStore", "loadFile failed: line1\nline2")
    #expect(line == "[TaskStore] loadFile failed: line1\\x0Aline2\n")
    // format 終端の \n は 1 個のみ (escape された \x0A の "n" 文字と区別できることの確認)
    #expect(line.filter { $0 == "\n" }.count == 1)
    #expect(line.hasSuffix("\n"))
  }

  @Test("空 message でも tag と改行は残る")
  func emptyMessage() {
    #expect(StderrLog.formatLine(tag: "GozdApp", "") == "[GozdApp] \n")
  }

  @Test("multi-byte UTF-8 を含む message も format に通せる")
  func multiByteMessage() {
    #expect(StderrLog.formatLine(tag: "GitOps", "rev-parse 失敗: \(1)") == "[GitOps] rev-parse 失敗: 1\n")
  }
}

@Suite("StderrLog.writeImpl (handle injection)")
struct StderrLogWriteTests {
  /// `Pipe` の write 側を `writeImpl` に渡し、read 側から output を取り出す。
  /// `dup2(STDERR_FILENO, ...)` で global stderr を乗っ取る方式だと、Swift Testing の
  /// 並列 runner が出す `◇ Test started` 等の stderr 出力と混線して test が flaky に
  /// なるため、handle injection で test isolation を担保する。
  private func captureWrite(_ action: (FileHandle) -> Void) -> String {
    let pipe = Pipe()
    action(pipe.fileHandleForWriting)
    pipe.fileHandleForWriting.closeFile()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    pipe.fileHandleForReading.closeFile()
    return String(decoding: data, as: UTF8.self)
  }

  @Test("writeImpl は formatLine の出力を渡された handle に書く")
  func writeMatchesFormatLine() {
    let captured = captureWrite { handle in
      StderrLog.writeImpl(tag: "handlePtySpawn", "pty.spawn failed: code=1", to: handle)
    }
    #expect(captured == StderrLog.formatLine(tag: "handlePtySpawn", "pty.spawn failed: code=1"))
    #expect(captured == "[handlePtySpawn] pty.spawn failed: code=1\n")
  }

  @Test("writeImpl は埋め込まれた改行を escape して 1 行で出す")
  func writeEscapesEmbeddedNewline() {
    let captured = captureWrite { handle in
      StderrLog.writeImpl(tag: "TaskStore", "raw \"a\nb\"", to: handle)
    }
    // 出力末尾の format 改行 1 個のみ。embedded \n は \x0A に escape される。
    #expect(captured.filter { $0 == "\n" }.count == 1)
    #expect(captured.contains("\\x0A"))
    #expect(captured.hasSuffix("\n"))
  }

  // 公開 API `write(tag:_:)` 自身の smoke test は意図的に書かない。
  //
  // - `write(tag:_:)` は `writeImpl(tag:_:to: .standardError)` への 1 行委譲。
  //   format / escape / lock の振る舞いは writeImpl 経路の test で完全に固定済み
  // - 仮に smoke で `write` を呼ぶと実 stderr に test 用 tag (e.g. `[TestSuite]`)
  //   が必ず混じり、観察ログ運用 (`grep '\[[A-Z]'` で経路を絞る) を test runner
  //   出力が汚染する。違反検出器の前提と齟齬が出る
  // - 委譲 1 行が壊れる risk は型 + writeImpl の test で十分閉じている
}
