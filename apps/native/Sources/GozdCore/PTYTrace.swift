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
// 出力先は GitHub Actions が capture するプロセスの stderr。swift-testing が
// stderr をテスト出力に含めるかは保証外で、実質的には Actions 側のログ capture に依存する。
//
// 行単位の整合性（複数スレッドからの同時 write で 1 行が分断・混線しない）は
// `FileHandle.standardError.write(contentsOf:)` 単独では保証されないため、自前の
// NSLock で serialize する。lock の取得はマイクロ秒オーダーで、観測したい race
// （EVFILT_READ / NOTE_EXIT の到着順）を潰す observer effect より、行が混線して
// 観測機構の信頼性が落ちる方が実害が大きいと判断した。
// 行間の到着順は時刻と pid タグから事後復元できるため lock 内では保証しない。
//
// 再発時に確認したい情報:
//
// - drainPTY 集約結果（dataReads, totalBytes, eintr, 終端区分）
// - read source / exit source の eventHandler 入退出順
// - waitpid の戻り値・status・errno・EINTR retry 回数
// - fcntl の戻り値（O_NONBLOCK 設定の成否）
// - PTYFinishState の状態遷移（markReadClosed / setExitReason / onComplete 発火）
//
// childPid を tag に入れることで PTYRegistryTests のように複数 PTY を並走させた
// ケースでも時系列を分離できる。

#if DEBUG
  private let ptyTraceEnabled: Bool = {
    ProcessInfo.processInfo.environment["GOZD_PTY_TRACE"] == "1"
  }()
  private let ptyTraceStart = ContinuousClock.now
  private let ptyTraceLock = NSLock()

  @inline(__always)
  func ptyTrace(_ tag: String, pid: Int32 = 0, _ message: @autoclosure () -> String) {
    guard ptyTraceEnabled else { return }
    let elapsed = ContinuousClock.now - ptyTraceStart
    let pidPart = pid == 0 ? "" : " pid=\(pid)"
    let line = "[PTY-TRACE +\(elapsed)\(pidPart) \(tag)] \(message())\n"
    guard let data = line.data(using: .utf8) else { return }
    ptyTraceLock.lock()
    defer { ptyTraceLock.unlock() }
    try? FileHandle.standardError.write(contentsOf: data)
  }
#else
  // release build でも関数定義自体は残るが、本体は空で `@inline(__always)` により
  // call site から完全に inline 展開・除去される（ABI 上のコストは無い）。
  @inline(__always)
  func ptyTrace(_ tag: String, pid: Int32 = 0, _ message: @autoclosure () -> String) {}
#endif
