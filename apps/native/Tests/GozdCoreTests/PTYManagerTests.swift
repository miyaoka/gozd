import Foundation
import Testing

@testable import GozdCore

// `.serialized` で直列実行する（issue #556 観測項目 4）。並列実行下では複数の PTY が
// 同時刻に spawn され、CI trace 上で pid 多重化が起きる。`resizeIsSafe` のような
// timeout 系 flake が再発した時、「どの pid を見ていたのか」をテスト失敗時刻と
// 一致する spawn pid から目で突き合わせるしか手段が無くなる。
// 本 suite は ローカル swift test 実測で 1 秒未満、CI macos-26 でも秒オーダー内に収まる
// ことを想定。直列化による性能劣化は許容範囲。
@Suite("PTYManager", .serialized)
struct PTYManagerTests {
  @Test("子プロセスの stdout を受け取り、正常終了 (.exited(0)) を検知する")
  func receivesOutputAndExit() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let data = DataCollector()
    let exit = ExitCollector()
    let pty = PTYManager()

    try pty.spawn(
      executable: "/bin/echo",
      args: ["echo", "hello"],
      env: ProcessInfo.processInfo.environment,
      cwd: "/tmp",
      rows: 24,
      cols: 80,
      onData: { data.append($0) },
      onExit: { exit.set($0) }
    )

    // issue ( #566 ) 観測: 本 test は CI attempt 1 で tick=1 ( +0.124s ) → tick=2 ( +2.405s )
    // と `Task.sleep(50ms)` が 2.28s stall した。polling loop 全体を GCD thread 上で完結
    // させる `waitUntilThreaded` に切り替えて、cooperative executor 外で tick が動くかを
    // 観測する。
    await waitUntilThreaded(timeout: .seconds(3)) { exit.snapshot() != nil }

    // pty (tty mode) は ONLCR で \n を \r\n に変換する。
    let text = String(decoding: data.snapshot(), as: UTF8.self)
    #expect(text.contains("hello"))
    #expect(exit.snapshot() == .exited(code: 0))
  }

  @Test("write した内容を子プロセス経由で読み戻せる（cat エコー）")
  func writeRoundTrip() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let data = DataCollector()
    let exit = ExitCollector()
    let pty = PTYManager()

    try pty.spawn(
      executable: "/bin/cat",
      args: ["cat"],
      env: ProcessInfo.processInfo.environment,
      cwd: "/tmp",
      rows: 24,
      cols: 80,
      onData: { data.append($0) },
      onExit: { exit.set($0) }
    )

    // tty が ready になるのを待つ。
    try await Task.sleep(for: .milliseconds(150))

    pty.write(Data("ping\n".utf8))

    try await waitUntil(timeout: .seconds(2)) {
      String(decoding: data.snapshot(), as: UTF8.self).contains("ping")
    }

    pty.kill()
    try await waitUntil(timeout: .seconds(2)) { exit.snapshot() != nil }

    if case .signaled(let sig, _) = exit.snapshot() {
      #expect(sig == SIGHUP)
    } else {
      Issue.record("expected SIGHUP signaled exit, got \(String(describing: exit.snapshot()))")
    }
  }

  @Test("resize は fd 確立前後で crash しない")
  func resizeIsSafe() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let pty = PTYManager()
    pty.resize(rows: 30, cols: 100)  // fd 未確立: no-op
    let data = DataCollector()
    let exit = ExitCollector()
    try pty.spawn(
      executable: "/bin/cat",
      args: ["cat"],
      env: ProcessInfo.processInfo.environment,
      cwd: "/tmp",
      rows: 24,
      cols: 80,
      onData: { data.append($0) },
      onExit: { exit.set($0) }
    )
    pty.resize(rows: 40, cols: 120)
    pty.kill()
    try await waitUntil(timeout: .seconds(2)) { exit.snapshot() != nil }
    #expect(exit.snapshot() != nil)
  }

  @Test("0 byte 出力で正常終了する child (/usr/bin/true) でも onExit が発火する")
  func zeroByteOutput() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let data = DataCollector()
    let exit = ExitCollector()
    let pty = PTYManager()

    try pty.spawn(
      executable: "/usr/bin/true",
      args: ["true"],
      env: ProcessInfo.processInfo.environment,
      cwd: "/tmp",
      rows: 24,
      cols: 80,
      onData: { data.append($0) },
      onExit: { exit.set($0) }
    )

    try await waitUntil(timeout: .seconds(3)) { exit.snapshot() != nil }

    // /usr/bin/true は何も出力せず exit 0 で終わる。
    // tty mode で promptless なので、データは 0 byte または echo 由来の数 byte のみ。
    #expect(exit.snapshot() == .exited(code: 0))
  }

  @Test("stderr のみに書く child の出力も master fd から読める")
  func stderrIsCapturedThroughSlave() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let data = DataCollector()
    let exit = ExitCollector()
    let pty = PTYManager()

    try pty.spawn(
      executable: "/bin/sh",
      args: ["sh", "-c", "echo stderr-marker >&2"],
      env: ProcessInfo.processInfo.environment,
      cwd: "/tmp",
      rows: 24,
      cols: 80,
      onData: { data.append($0) },
      onExit: { exit.set($0) }
    )

    try await waitUntil(timeout: .seconds(3)) { exit.snapshot() != nil }

    // login_tty で slave fd は stdin/stdout/stderr すべてに dup2 されているため
    // stderr 出力も master 経由で観測できる。
    let text = String(decoding: data.snapshot(), as: UTF8.self)
    #expect(text.contains("stderr-marker"))
    #expect(exit.snapshot() == .exited(code: 0))
  }

  @Test("存在しない cwd を指定すると exited(code: 124) を返す (chdir 失敗)")
  func chdirFailureReportedAsExit124() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let data = DataCollector()
    let exit = ExitCollector()
    let pty = PTYManager()

    // 実行時に確実に存在しないパスを動的生成。固定文字列ハードコードだと
    // 偶発的にユーザーがそのパスを作っていると test が偽陰性になる。
    // CLAUDE.md 「`/tmp` をハードコードしない、`NSTemporaryDirectory()` を使う」に準拠。
    let nonexistentCwd =
      (NSTemporaryDirectory() as NSString)
      .appendingPathComponent("gozd-chdir-test-\(UUID().uuidString)")

    try pty.spawn(
      executable: "/usr/bin/true",
      args: ["true"],
      env: ProcessInfo.processInfo.environment,
      // 動的生成した「絶対に存在しない」パス。CPty.c の chdir() != 0 経路で _exit(124)。
      cwd: nonexistentCwd,
      rows: 24,
      cols: 80,
      onData: { data.append($0) },
      onExit: { exit.set($0) }
    )

    try await waitUntil(timeout: .seconds(3)) { exit.snapshot() != nil }
    #expect(exit.snapshot() == .exited(code: 124))
  }

  @Test("ディレクトリを executable に指定すると exited(code: 126) を返す (execve EACCES)")
  func execveEACCESReportedAsExit126() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let data = DataCollector()
    let exit = ExitCollector()
    let pty = PTYManager()

    // /tmp はディレクトリで execute bit は付くが execve は EACCES を返す
    // （macOS execve(2): 「The new process file is not a regular file」も含めて EACCES）。
    try pty.spawn(
      executable: "/tmp",
      args: ["tmp"],
      env: ProcessInfo.processInfo.environment,
      cwd: "/tmp",
      rows: 24,
      cols: 80,
      onData: { data.append($0) },
      onExit: { exit.set($0) }
    )

    try await waitUntil(timeout: .seconds(3)) { exit.snapshot() != nil }
    #expect(exit.snapshot() == .exited(code: 126))
  }

  @Test("実行できないパス (/path/does/not/exist) は exited(code: 127) を返す")
  func execveENOENTReportedAsExit127() async throws {
    testTrace("started")
    defer { testTrace("ended") }
    let data = DataCollector()
    let exit = ExitCollector()
    let pty = PTYManager()

    try pty.spawn(
      executable: "/path/does/not/exist",
      args: ["nonexistent"],
      env: ProcessInfo.processInfo.environment,
      cwd: "/tmp",
      rows: 24,
      cols: 80,
      onData: { data.append($0) },
      onExit: { exit.set($0) }
    )

    try await waitUntil(timeout: .seconds(3)) { exit.snapshot() != nil }

    // POSIX shell 慣例 / CPty.c の child で execve ENOENT → _exit(127)。
    #expect(exit.snapshot() == .exited(code: 127))
  }

  @Test("PTYError の description は `PTYError.<case>(errno=<n> <strerror>)` 形式で完全一致する")
  func ptyErrorDescriptionMatchesContractFormat() {
    // RpcSchemeHandler が `"\(error)"` で 500 response payload を作るため、
    // CustomStringConvertible に乗った description が renderer まで届く文字列となる。
    // PR 本文と doc コメントで宣言した形式を **完全一致** で固定する。substring
    // 検査では「無関係文言が混ざっても pass する」「他 case 名が混入しても pass する」
    // を許してしまうため契約として弱い。
    let openpty = PTYError.openptyFailed(errno: ENOMEM)
    #expect(openpty.description == "PTYError.openptyFailed(errno=\(ENOMEM) \(expectedErrnoText(ENOMEM)))")
    #expect("\(openpty)" == openpty.description)

    let fork = PTYError.forkFailed(errno: EAGAIN)
    #expect(fork.description == "PTYError.forkFailed(errno=\(EAGAIN) \(expectedErrnoText(EAGAIN)))")
    #expect("\(fork)" == fork.description)

    let prealloc = PTYError.preforkAllocFailed(errno: ENOMEM)
    #expect(prealloc.description == "PTYError.preforkAllocFailed(errno=\(ENOMEM) \(expectedErrnoText(ENOMEM)))")
    #expect("\(prealloc)" == prealloc.description)
  }

  @Test("PTYExitReason の description は case ごとに付随情報を含む形式で完全一致する")
  func ptyExitReasonDescriptionMatchesContractFormat() {
    // `PTYError` と対称に、`PTYExitReason` も `"\(reason)"` で stderr / log に
    // 残す経路で case 名 + 付随情報が確実に出ることを契約として固定する。
    let exited = PTYExitReason.exited(code: 42)
    #expect(exited.description == "PTYExitReason.exited(code=42)")
    #expect("\(exited)" == exited.description)

    let signaled = PTYExitReason.signaled(signal: SIGHUP, coreDumped: false)
    #expect(signaled.description == "PTYExitReason.signaled(signal=\(SIGHUP) coreDumped=false)")
    #expect("\(signaled)" == signaled.description)

    let stopped = PTYExitReason.stopped
    #expect(stopped.description == "PTYExitReason.stopped")
    #expect("\(stopped)" == stopped.description)

    let waitFail = PTYExitReason.waitpidFailed(errno: ECHILD)
    #expect(waitFail.description == "PTYExitReason.waitpidFailed(errno=\(ECHILD) \(expectedErrnoText(ECHILD)))")
    #expect("\(waitFail)" == waitFail.description)
  }

  @Test("errnoText は無効 errno (rc != 0 経路) で `unknown errno N` に倒れる")
  func errnoTextFallsBackOnInvalidErrno() {
    // POSIX 文面では `strerror_r` の `rc != 0` 時の buffer 内容は未定義。本実装は
    // この未定義領域を信じず明示的 fallback 文字列 `"unknown errno N"` を返す契約。
    // 9999 は POSIX で定義されていない invalid errno の代表値（Linux / macOS で
    // EINVAL を返す）。本契約が壊れると、観察ログに macOS バージョン依存の Darwin
    // 文字列が漏れ出して観察可能性が分散する。
    let invalid = PTYError.openptyFailed(errno: 9999)
    #expect(invalid.description == "PTYError.openptyFailed(errno=9999 unknown errno 9999)")
    #expect("\(invalid)" == invalid.description)

    // PTYExitReason 側も同じ fallback 経路を踏むことを確認。`errnoText` の SSOT が
    // 2 enum で共有されていることの構造的検証も兼ねる。
    let waitFail = PTYExitReason.waitpidFailed(errno: 9999)
    #expect(waitFail.description == "PTYExitReason.waitpidFailed(errno=9999 unknown errno 9999)")
  }
}

/// 本 SUT (`PTYError.errnoText`) と同じ実装を **意図的に** 再現した mirror。
///
/// 構造的 SSOT 重複に見えるが、これは形式契約 test の道具立てとして妥当な
/// パターン:
///   - test の目的は「`description` が `PTYError.<case>(errno=<n> <strerror>)`
///     形式に厳密に従う」契約を完全一致で固定すること
///   - macOS の strerror_r 出力文字列はバージョン依存（"Cannot allocate memory" /
///     "Resource temporarily unavailable" 等）で test に直書きすると CI で壊れる
///   - そのため期待値も同じ `strerror_r` API から組み立てる必要がある
///
/// 別案として正規表現 / prefix+suffix での形式検査も検討したが、それでは前回
/// 強化した「完全一致で形式を fix する」契約が弱まる。SUT と mirror が同じ
/// イディオムを使うこと自体が形式契約の test 対象になっている。SUT 側
/// `errnoText` のイディオムを変える時は本 helper も同時に同期更新する。
///
/// rc != 0 (無効 errno) 経路は SUT 側で `"unknown errno N"` に倒すが、本 helper は
/// rc を捨てて buffer の中身を文字列化する。両者の差異は `errnoTextFallsBackOnInvalidErrno`
/// test で SUT 側の文字列形式に対する完全一致として固定する（本 helper は呼ばれない）。
private func expectedErrnoText(_ code: Int32) -> String {
  var buf = [CChar](repeating: 0, count: 256)
  _ = strerror_r(code, &buf, buf.count)
  let nul = buf.firstIndex(of: 0) ?? buf.endIndex
  return String(decoding: buf[..<nul].lazy.map { UInt8(bitPattern: $0) }, as: UTF8.self)
}

// MARK: - Helpers

// `waitUntil` / `waitUntilThreaded` は `WaitUntil.swift` の共有実装を使う
// （issue #556 観測項目 3 / issue #566 観測項目）。
// tick polling 履歴を持ち、timeout 時に Issue.record の message に inline する。
// `receivesOutputAndExit` のみ `waitUntilThreaded` ( GCD thread で polling loop 完結 ) を使い、
// 他 test は `waitUntil` ( Task.sleep 経路 ) のまま並走させて同 stall window で経路を比較する。

private final class DataCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var data = Data()

  func append(_ chunk: Data) {
    lock.lock()
    defer { lock.unlock() }
    data.append(chunk)
  }

  func snapshot() -> Data {
    lock.lock()
    defer { lock.unlock() }
    return data
  }
}

private final class ExitCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var reason: PTYExitReason?

  func set(_ value: PTYExitReason) {
    lock.lock()
    defer { lock.unlock() }
    reason = value
  }

  func snapshot() -> PTYExitReason? {
    lock.lock()
    defer { lock.unlock() }
    return reason
  }
}
