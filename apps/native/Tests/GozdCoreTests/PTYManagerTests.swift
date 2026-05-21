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

  @Test("errnoText は invalid / sentinel errno でも description 形式 (errno 値 + 閉じ括弧) を保つ")
  func errnoTextHandlesBoundaryErrnoSafely() {
    // 境界 errno をまとめて検査する:
    //   - 9999: POSIX で未定義の invalid errno
    //   - 0:    "エラー無し" sentinel（waitpidFailed で渡されることは構造的に想定外だが
    //          Int32 型で構造的に渡せるため境界として cover する）
    //   - -1:   負の errno（Int32 で渡せる構造的境界）
    //
    // SUT (`errnoText`) は rc を信用せず buffer を返す方針のため、Darwin / Linux glibc
    // 双方で invalid / sentinel errno に対しても buffer に readable な文字列が書かれる
    // 実機挙動を尊重する。ただしその文字列内容 (`"Unknown error: 9999"` / `"Undefined
    // error: 0"` 等) は OS バージョン依存で test に直書きできない。
    //
    // よってここでは「OS 実装に依存せず保証される不変条件」のみを固定する:
    //   - description は `"PTYError.<case>(errno=N "` で始まる
    //   - 末尾は `")"` で閉じる
    //   - errno 数値が必ず embed される
    // 完全一致が必要な valid errno 3 case (`ptyErrorDescriptionMatchesContractFormat`)
    // とは責務を分ける: 完全一致は SSOT mirror で組み立てた expected と等価性を主張、
    // 本 test は OS 実装差を吸収する形式契約。
    // Int32 の真の境界 (max / min) も含む。`PTYError.openptyFailed(errno:)` 等の
    // associated value は `Int32` で受けるため構造的に渡せる入力域全体を境界として
    // 扱う。`strerror_r` の第 1 引数 (`int` = `Int32`) は POSIX 文面では errno 値域
    // 外のときに EINVAL を返すが、これは指摘 A の printable-ASCII チェック経路で
    // safely fallback に倒れる契約。
    for code: Int32 in [Int32.max, Int32.min, 9999, 0, -1] {
      let openpty = PTYError.openptyFailed(errno: code)
      #expect(openpty.description.hasPrefix("PTYError.openptyFailed(errno=\(code) "))
      #expect(openpty.description.hasSuffix(")"))
      #expect("\(openpty)" == openpty.description)

      let waitFail = PTYExitReason.waitpidFailed(errno: code)
      #expect(waitFail.description.hasPrefix("PTYExitReason.waitpidFailed(errno=\(code) "))
      #expect(waitFail.description.hasSuffix(")"))
    }
  }

  @Test("errnoText の strerror 出力部分は印字可能 ASCII / 非空 / 単一行 (SUT 単独不変条件)")
  func errnoTextStrerrorOutputIsAsciiPrintableSingleLine() {
    // `ptyErrorDescriptionMatchesContractFormat` は SUT と同根の `expectedErrnoText`
    // mirror で完全一致を主張するため、SUT と mirror が同じバグを抱えると pass して
    // しまう（reviewer 指摘 E）。これを補強するため、SUT 単独で観察可能な strerror
    // 出力の最低限の品質を assert する。
    //
    // mirror に依存せず、description 文字列から `errnoText` 出力部分を抽出して
    // 検証する。`errnoText` の出力品質契約:
    //   - 非空
    //   - 印字可能 ASCII (0x20–0x7E) のみで構成される（SUT 側の防御と一致）
    //   - 改行 / TAB / 制御文字を含まない
    // 具体的な文字列内容（"Cannot allocate memory" 等）は macOS バージョン依存
    // なので主張しない。あくまで「観察ログを壊さない品質」を fix する。
    for code: Int32 in [ENOMEM, EAGAIN, ECHILD, EINTR, EFAULT, 0, -1, 9999] {
      let desc = PTYError.openptyFailed(errno: code).description
      // 形式: "PTYError.openptyFailed(errno=N <strerror>)" から <strerror> を抽出
      let prefix = "PTYError.openptyFailed(errno=\(code) "
      #expect(desc.hasPrefix(prefix))
      #expect(desc.hasSuffix(")"))
      let strerrorStart = desc.index(desc.startIndex, offsetBy: prefix.count)
      let strerrorEnd = desc.index(before: desc.endIndex)
      let strerrorText = desc[strerrorStart..<strerrorEnd]
      #expect(!strerrorText.isEmpty, "errno=\(code) produced empty strerror text")
      #expect(
        strerrorText.unicodeScalars.allSatisfy { $0.value >= 0x20 && $0.value <= 0x7E },
        "errno=\(code) strerror text contains non-printable-ASCII: \(strerrorText.debugDescription)"
      )
    }
  }
}

/// 本 SUT (`PTYError.errnoText`) と同じ実装を **意図的に** 再現した mirror。
/// `ptyErrorDescriptionMatchesContractFormat` / `ptyExitReasonDescriptionMatchesContractFormat`
/// から呼ばれ、valid errno (ENOMEM / EAGAIN / ECHILD / SIGHUP 等) に対して
/// SUT が生成する `description` の完全一致 expected を組み立てる。
///
/// 構造的 SSOT 重複に見えるが、これは形式契約 test の道具立てとして妥当な
/// パターン:
///   - test の目的は「`description` が `PTYError.<case>(errno=<n> <strerror>)`
///     形式に厳密に従う」契約を完全一致で固定すること
///   - macOS の strerror_r 出力文字列はバージョン依存（"Cannot allocate memory" /
///     "Resource temporarily unavailable" 等）で test に直書きすると CI で壊れる
///   - そのため期待値も同じ `strerror_r` API から組み立てる必要がある
///
/// 別案として正規表現 / prefix+suffix での形式検査も検討したが、valid errno に
/// 対しては「完全一致で形式を fix する」契約が望ましい。SUT と mirror が同じ
/// イディオムを使うこと自体が形式契約の test 対象になっている。SUT 側
/// `errnoText` のイディオムを変える時は本 helper も同時に同期更新する。
///
/// 限界: 本 helper と SUT が同じイディオムで実装されているため、両者に同じバグが
/// 入った場合 (例: UTF-8 解釈ミス、buffer サイズ不足、bitPattern reinterpret 誤り)
/// この test 経路では検出できない。この相互救済を断つため、SUT 単独の strerror 出力
/// 品質 test (`errnoTextStrerrorOutputIsAsciiPrintableSingleLine`) を別途置き、
/// mirror に依存しない不変条件（印字可能 ASCII / 非空 / 単一行）も assert している。
///
/// boundary errno (Int32.max / Int32.min / 9999 / 0 / -1) に対する OS 実装差吸収は
/// 別 test (`errnoTextHandlesBoundaryErrnoSafely`) で prefix/suffix の不変条件のみを
/// 主張する形に分離している。本 helper は boundary 経路では呼ばれない。
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
