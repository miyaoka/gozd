import Foundation
import Testing

@testable import GozdCore

@Suite("CommandResolver")
struct CommandResolverTests {
  @Test("git は絶対パスで解決できる（PATH 走査または login shell 経由）")
  func resolvesGit() async throws {
    let resolver = CommandResolver()
    let path = try await resolver.resolve("git")
    #expect(path != nil)
    if let path {
      #expect(path.hasPrefix("/"))
      #expect(FileManager.default.isExecutableFile(atPath: path))
    }
  }

  @Test("存在しないコマンドは nil を返す")
  func returnsNilForUnknownCommand() async throws {
    let resolver = CommandResolver()
    // 衝突しないよう UUID を含める。`-` は guard で許可されているので含めて OK。
    let bogus = "gozd_nonexistent_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
    let path = try await resolver.resolve(bogus)
    #expect(path == nil)
  }

  @Test("不正な name は launchFailed を throw する")
  func rejectsInvalidName() async {
    let resolver = CommandResolver()
    await #expect(throws: GitError.self) {
      _ = try await resolver.resolve("git; rm -rf /")
    }
    await #expect(throws: GitError.self) {
      _ = try await resolver.resolve("")
    }
  }

  @Test("同名の連続 resolve は同じパスを返す（キャッシュ）")
  func cachesResult() async throws {
    let resolver = CommandResolver()
    let p1 = try await resolver.resolve("git")
    let p2 = try await resolver.resolve("git")
    #expect(p1 == p2)
    #expect(p1 != nil)
  }

  @Test("invalidate 後の resolve も同じパスを返す（再解決）")
  func reResolvesAfterInvalidate() async throws {
    let resolver = CommandResolver()
    let p1 = try await resolver.resolve("git")
    await resolver.invalidate("git")
    let p2 = try await resolver.resolve("git")
    #expect(p1 == p2)
  }

  @Test("並列 resolve は重複起動しない（inflight 共有）")
  func deduplicatesInflightResolves() async throws {
    let resolver = CommandResolver()
    async let a = try resolver.resolve("git")
    async let b = try resolver.resolve("git")
    async let c = try resolver.resolve("git")
    let results = try await [a, b, c]
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
  @Test("不明コマンドの解決は 30 秒以内に nil で返る（timeout 経路を含めても無限 hang しない）")
  func resolveDoesNotHangIndefinitely() async throws {
    let resolver = CommandResolver()
    let bogus = "gozd_hang_probe_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
    let start = Date()
    let result = try await resolver.resolve(bogus)
    let elapsed = Date().timeIntervalSince(start)
    // 「nil で帰った」ことを明示。throw で即返ったり何かが解決されたケースを別の失敗として扱う。
    #expect(result == nil)
    #expect(elapsed < 30.0)
  }

  @Test("`-l -c command -v` を解釈する別 shell (/bin/sh) でも SETSID 経路で hang しない")
  func resolvesViaSh() async throws {
    let resolver = CommandResolver(shellOverride: "/bin/sh")
    let start = Date()
    let path = try await resolver.resolve("ls")
    let elapsed = Date().timeIntervalSince(start)
    #expect(path != nil)
    if let path { #expect(path.hasPrefix("/")) }
    #expect(elapsed < 30.0)
  }

  @Test("/bin/bash も SETSID 経路で hang せず ls を解決できる")
  func resolvesViaBash() async throws {
    let resolver = CommandResolver(shellOverride: "/bin/bash")
    let start = Date()
    let path = try await resolver.resolve("ls")
    let elapsed = Date().timeIntervalSince(start)
    #expect(path != nil)
    if let path { #expect(path.hasPrefix("/")) }
    #expect(elapsed < 30.0)
  }

  @Test("nil 結果は negative cache に入って 2 回目は spawn を再起動しない")
  func cachesNegativeResult() async throws {
    let resolver = CommandResolver()
    let bogus = "gozd_negcache_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
    let r1 = try await resolver.resolve(bogus)
    let start = Date()
    let r2 = try await resolver.resolve(bogus)
    let elapsed = Date().timeIntervalSince(start)
    #expect(r1 == nil)
    #expect(r2 == nil)
    // 2 回目は cache hit のため一瞬で返るはず（spawn しないので 100ms 未満）
    #expect(elapsed < 0.1)
  }
}
