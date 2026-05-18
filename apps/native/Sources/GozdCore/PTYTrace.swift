import Foundation

// PTY ライフサイクル / テスト境界の観測ログ。
//
// production の hot path（drainPTY のループ / setEventHandler コールバック / PTYManager の
// public method）に呼び出しを仕込むため、二重 gate で release build には一切影響を出さない:
//
// - `#if DEBUG` で release build からは関数実体ごと除外
// - DEBUG build でも環境変数 `GOZD_PTY_TRACE=1` が無ければ即座に return
//
// 出力先は GitHub Actions が capture するプロセスの stderr。
//
// 行単位の整合性（複数スレッドからの同時 write で 1 行が分断・混線しない）は
// `FileHandle.standardError.write(contentsOf:)` 単独では保証されないため、自前の
// NSLock で serialize する。観測したい race を潰す observer effect より、行が混線して
// 観測機構の信頼性が落ちる方が実害が大きいと判断した。
// 行間の到着順は時刻と pid タグから事後復元できるため lock 内では保証しない。
//
// `[PTY-TRACE]` と `[TEST-TRACE]` の 2 系統を持つ:
//
// - `[PTY-TRACE]`: GozdCore 内の PTY ライフサイクルイベント。`ptyTrace` から発射。
// - `[TEST-TRACE]`: テスト境界 / `waitUntil` の polling 推移。テスト target から
//   `gozdTraceLine` で発射する。
//
// 両系統は `gozdTraceStart` 基準の同一 elapsed 時刻 + 同一 stderr lock を共有する。
// PTY 内部状態とテスト経路の絶対時刻を 1 本のログ stream 上で突き合わせるのが目的。
// 別 prefix にしているのは grep で分離可能にするためで、時系列分離の意図ではない。
//
// 再発時に確認したい情報:
//
// - drainPTY 集約結果（dataReads, totalBytes, eintr, 終端区分）
// - read source / exit source の eventHandler 入退出順
// - waitpid の戻り値・status・errno・EINTR retry 回数
// - fcntl の戻り値（O_NONBLOCK 設定の成否）
// - PTYFinishState の状態遷移（markReadClosed / setExitReason / onComplete 発火）
// - PTYManager.resize / kill / write の呼び出し境界、ioctl(TIOCSWINSZ) / kill(SIGHUP) の戻り値・errno
// - waitUntil の tick ごとの condition 結果と timeout 時の polling history
//
// childPid を tag に入れることで PTYRegistryTests のように複数 PTY を並走させた
// ケースでも時系列を分離できる。

#if DEBUG
  /// 環境変数で trace を gate する。production の hot path で常に呼ばれることを想定。
  let gozdTraceEnabled: Bool = {
    ProcessInfo.processInfo.environment["GOZD_PTY_TRACE"] == "1"
  }()
  /// 「`gozdTraceStart` シンボルへの最初の参照時点」を基準にした相対時刻の起点。
  /// Swift の global `let` は最初の参照時 lazy 初期化（言語仕様で thread-safe）。
  /// 通常 `ptyTrace` / `testTrace` のいずれかから最初に触れた瞬間に初期化されるため、
  /// 厳密には「プロセス起動からの elapsed」ではなく「最初の trace 呼び出しからの elapsed」。
  /// `[PTY-TRACE]` / `[TEST-TRACE]` の elapsed は同一プロセス内なら同じ `let` を共有するため
  /// 両系統の elapsed は相対比較可能。プロセス起動からの absolute は要求していない。
  let gozdTraceStart = ContinuousClock.now
  private let gozdTraceLock = NSLock()

  /// 形成済みの 1 行を atomic に stderr へ流す。複数 thread からの同時呼び出しで行が
  /// 分断・混線するのを防ぐ。改行は呼び出し側で含めること。
  @inline(__always)
  func gozdTraceLine(_ line: String) {
    guard gozdTraceEnabled else { return }
    guard let data = line.data(using: .utf8) else { return }
    gozdTraceLock.lock()
    defer { gozdTraceLock.unlock() }
    try? FileHandle.standardError.write(contentsOf: data)
  }

  @inline(__always)
  func ptyTrace(_ tag: String, pid: Int32 = 0, _ message: @autoclosure () -> String) {
    guard gozdTraceEnabled else { return }
    let elapsed = ContinuousClock.now - gozdTraceStart
    let pidPart = pid == 0 ? "" : " pid=\(pid)"
    gozdTraceLine("[PTY-TRACE +\(elapsed)\(pidPart) \(tag)] \(message())\n")
  }
#else
  // release build でも関数定義自体は残るが、本体は空で `@inline(__always)` により
  // call site から完全に inline 展開・除去される（ABI 上のコストは無い）。
  // `gozdTraceStart` は release build では宣言しない。test target は `@testable import GozdCore`
  // 経由で参照するが、`@testable` は DEBUG build を要求するため #else 経路では到達不能。
  // 不要な `ContinuousClock.now` evaluation が linker dead-strip 通過後に残る経路を塞ぐ。
  let gozdTraceEnabled: Bool = false
  @inline(__always) func gozdTraceLine(_ line: String) {}
  @inline(__always)
  func ptyTrace(_ tag: String, pid: Int32 = 0, _ message: @autoclosure () -> String) {}
#endif
