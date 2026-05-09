import Foundation
import Testing

@testable import GozdCore

@Suite("CommandResolver")
struct CommandResolverTests {
  @Test("git は絶対パスで解決できる（PATH 走査または login shell 経由）")
  func resolvesGit() async {
    let resolver = CommandResolver()
    let path = await resolver.resolve("git")
    #expect(path != nil)
    if let path {
      #expect(path.hasPrefix("/"))
      #expect(FileManager.default.isExecutableFile(atPath: path))
    }
  }

  @Test("存在しないコマンドは nil を返す")
  func returnsNilForUnknownCommand() async {
    let resolver = CommandResolver()
    // 衝突しないよう UUID を含める
    let bogus = "gozd_nonexistent_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
    let path = await resolver.resolve(bogus)
    #expect(path == nil)
  }

  @Test("同名の連続 resolve は同じパスを返す（キャッシュ）")
  func cachesResult() async {
    let resolver = CommandResolver()
    let p1 = await resolver.resolve("git")
    let p2 = await resolver.resolve("git")
    #expect(p1 == p2)
    #expect(p1 != nil)
  }

  @Test("invalidate 後の resolve も同じパスを返す（再解決）")
  func reResolvesAfterInvalidate() async {
    let resolver = CommandResolver()
    let p1 = await resolver.resolve("git")
    await resolver.invalidate("git")
    let p2 = await resolver.resolve("git")
    #expect(p1 == p2)
  }

  @Test("並列 resolve は重複起動しない（inflight 共有）")
  func deduplicatesInflightResolves() async {
    let resolver = CommandResolver()
    async let a = resolver.resolve("git")
    async let b = resolver.resolve("git")
    async let c = resolver.resolve("git")
    let results = await [a, b, c]
    #expect(results[0] != nil)
    #expect(results[0] == results[1])
    #expect(results[1] == results[2])
  }

  /// hang 系 shell の検証用に SHELL を `sleep infinity` を実行する自前バイナリに
  /// 差し替えるのは困難（シェル interpreter として呼ばれる必要がある）なので、
  /// 公開 API では「resolver が永久 hang しないこと」を timeout 観測で確認する。
  ///
  /// 不明コマンドを解決するパスは `lookupViaLoginShell` を必ず通る。rc が極端に重く
  /// ても 10 秒で SIGKILL されるため、テスト全体は数秒で終わる必要がある。
  @Test("不明コマンドの解決は 30 秒以内に完了する（timeout 経路を含めても無限 hang しない）")
  func resolveDoesNotHangIndefinitely() async throws {
    let resolver = CommandResolver()
    let bogus = "gozd_hang_probe_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
    let start = Date()
    _ = await resolver.resolve(bogus)
    let elapsed = Date().timeIntervalSince(start)
    #expect(elapsed < 30.0)
  }
}
