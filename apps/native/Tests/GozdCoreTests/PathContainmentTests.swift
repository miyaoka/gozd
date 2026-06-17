import Testing

@testable import GozdCore

@Suite("resolveContained (path containment SSOT)")
struct PathContainmentTests {
  // FS 非依存を保証するため、存在しない base を使う (削除済み worktree root 相当)。
  let base = "/Users/x/.local/share/gozd/worktrees/deleted-wt/branch"

  @Test("空 / \".\" は base 自身に解決する")
  func rootResolvesToBase() {
    #expect(resolveContained(base: base, subpath: "") == base)
    #expect(resolveContained(base: base, subpath: ".") == base)
  }

  @Test("通常の相対 path は base 配下に join する")
  func joinsRelative() {
    #expect(resolveContained(base: base, subpath: "sub/a.txt") == base + "/sub/a.txt")
  }

  @Test("内部の \"..\" は base を抜けなければ正規化して許可する")
  func normalizesInnerDotDot() {
    #expect(resolveContained(base: base, subpath: "a/../b") == base + "/b")
  }

  @Test("base を抜ける \"..\" traversal は nil")
  func rejectsEscapingDotDot() {
    #expect(resolveContained(base: base, subpath: "../escape") == nil)
    #expect(resolveContained(base: base, subpath: "a/../../b") == nil)
  }

  @Test("絶対パス注入は root を除去して base 配下へ閉じ込める")
  func neutralizesAbsoluteInjection() {
    #expect(resolveContained(base: base, subpath: "/etc/passwd") == base + "/etc/passwd")
  }
}
