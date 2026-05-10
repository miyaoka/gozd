import Foundation

// PTYRegistryTests.spawnAndExitDispatch が CI 環境（macos-26 runner）で稀に flaky に
// なる問題（issue #450）の原因特定用トレース。
//
// production の hot path（drainPTY のループ / setEventHandler コールバック）に呼び出しを
// 仕込むため、二重 gate で release build には一切影響を出さない:
//
// 1. `#if DEBUG` で release build からは関数実体ごと除外
// 2. DEBUG build でも環境変数 `GOZD_PTY_TRACE=1` が無ければ即座に return
//
// 出力先は stderr 直書き。swift-testing は CI 上で stderr を取り込むため、
// 別途バッファ機構を持たずに済む。各 trace 行は単一 `write(_:)` でアトミックに出るため、
// マルチスレッドでも 1 行が分断されない（同時 write の行間順序は保証しないが、
// 行内の整合性は保たれる）。
//
// 再発時に確認したい情報:
//
// - drainPTY の各 read 結果（n, errno, fd, 累積 bytes）
// - read source / exit source の eventHandler 入退出順
// - waitpid の status
// - PTYFinishState の状態遷移（markReadClosed / setExitReason / onComplete 発火）
//
// childPid を tag に入れることで PTYRegistryTests のように複数 PTY を並走させた
// ケースでも時系列を分離できる。

#if DEBUG
  private let ptyTraceEnabled: Bool = {
    ProcessInfo.processInfo.environment["GOZD_PTY_TRACE"] == "1"
  }()
  private let ptyTraceStart = ContinuousClock.now

  @inline(__always)
  func ptyTrace(_ tag: String, pid: Int32 = 0, _ message: @autoclosure () -> String) {
    guard ptyTraceEnabled else { return }
    let elapsed = ContinuousClock.now - ptyTraceStart
    let pidPart = pid == 0 ? "" : " pid=\(pid)"
    let line = "[PTY-TRACE +\(elapsed)\(pidPart) \(tag)] \(message())\n"
    if let data = line.data(using: .utf8) {
      try? FileHandle.standardError.write(contentsOf: data)
    }
  }
#else
  @inline(__always)
  func ptyTrace(_ tag: String, pid: Int32 = 0, _ message: @autoclosure () -> String) {}
#endif
