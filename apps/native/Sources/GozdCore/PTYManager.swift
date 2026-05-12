import CPty
import Darwin
import Foundation

// forkpty + DispatchSourceRead をラップする PTY マネージャー。
//
// 設計判断（spike `gozd-spike` で検証済み）:
//
// 1. **`@unchecked Sendable` を付けない**。non-Sendable class として単一 context（@MainActor
//    または専用 actor）から所有・操作する前提。FSWatcher と同じ流儀。
//
// 2. **read source の closure は self をキャプチャしない**。setEventHandler は
//    `@Sendable () -> Void` を要求するため、non-Sendable self を捕まえると Swift 6.2
//    strict concurrency 下でエラー。closure には `fd: Int32`、`onData: @Sendable`、
//    `source` だけを渡し、EOF / read error 時は `source.cancel()` → cancelHandler の
//    `close(fd)` で片付ける。
//
// 3. **fork 子側は C 呼び出しのみ**。`chdir / execve / _exit` のみ使用。argv / envp /
//    cwd / executable は呼び出し前に C 配列として確保し、親側で fork 後に free する
//    （COW なので子に影響しない）。
//
// 4. **kill は SIGHUP**。SIGTERM では interactive zsh が無視するため SIGHUP 固定
//    （spike で検証）。
//
// 5. **waitpid status decode は手動**。`WIFEXITED` 等の C マクロは Swift から不可視
//    のため、ビット演算で `.exited / .signaled / .stopped` を判別する。
public final class PTYManager {
  public typealias DataHandler = @Sendable (Data) -> Void
  public typealias ExitHandler = @Sendable (PTYExitReason) -> Void

  public private(set) var primaryFd: Int32 = -1
  public private(set) var pid: pid_t = -1
  private var readSource: DispatchSourceRead?
  private var exitSource: DispatchSourceProcess?

  public init() {}

  deinit {
    readSource?.cancel()
    exitSource?.cancel()
  }

  /// 子プロセスを PTY に fork して spawn する。
  ///
  /// - Parameters:
  ///   - executable: 実行ファイルの絶対パス（例: `/bin/zsh`）。
  ///   - args: argv。慣例として args[0] に実行ファイル名を入れる。
  ///   - env: 環境変数。`KEY=VALUE` 形式に整形して渡される。
  ///   - cwd: 子プロセスの作業ディレクトリ。
  ///   - rows / cols: 初期の terminal サイズ。
  ///   - onData: PTY master fd から読み取ったバイト列を受け取る。バックグラウンドキューから呼ばれる。
  ///   - onExit: 子プロセス終了時に呼ばれる。バックグラウンドキューから呼ばれる。
  public func spawn(
    executable: String,
    args: [String],
    env: [String: String],
    cwd: String,
    rows: UInt16,
    cols: UInt16,
    onData: @escaping DataHandler,
    onExit: @escaping ExitHandler
  ) throws {
    let argEntries: [UnsafeMutablePointer<CChar>?] =
      (args + [nil]).map { $0.flatMap { strdup($0) } }
    let argv = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(
      capacity: argEntries.count)
    argv.initialize(from: argEntries, count: argEntries.count)

    let envStrings = env.map { "\($0.key)=\($0.value)" }
    let envEntries: [UnsafeMutablePointer<CChar>?] =
      (envStrings + [nil]).map { $0.flatMap { strdup($0) } }
    let envp = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(
      capacity: envEntries.count)
    envp.initialize(from: envEntries, count: envEntries.count)

    let cExecutable = strdup(executable)
    let cCwd = strdup(cwd)

    // strdup 失敗 (OOM) を検出する。最終要素は意図的な nil terminator なので dropLast で
    // 除外。nil が混入したまま execve に渡すと argv / envp が想定外の位置で terminate されて
    // 子が異常起動する。OOM 状態は他も壊れる極端ケースだが、silent に異常 spawn する
    // 経路は塞ぐ。
    if argEntries.dropLast().contains(where: { $0 == nil })
      || envEntries.dropLast().contains(where: { $0 == nil })
      || cExecutable == nil || cCwd == nil
    {
      freeCStrings(argEntries, envEntries, cExecutable, cCwd, argv, envp)
      throw PTYError.preforkAllocFailed(errno: ENOMEM)
    }

    var ws = winsize(ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0)
    var fd: Int32 = -1
    let childPid = forkpty(&fd, nil, nil, &ws)

    if childPid == -1 {
      let err = errno
      freeCStrings(argEntries, envEntries, cExecutable, cCwd, argv, envp)
      throw PTYError.forkptyFailed(errno: err)
    }

    if childPid == 0 {
      // 子側: Swift heap / ARC に触れない。C 呼び出しのみ。
      //
      // fork-exec 標準衛生（POSIX 系の shell / spawner 全般がやっている）:
      //
      // (1) signal mask をクリア。
      //     `man 2 execve`: 「Blocked signals remain blocked regardless of changes to
      //     the signal action.」 → 親が sigprocmask で block している signal は
      //     execve を超えて子に継承され、子側で SIG_DFL にしても delivery されない。
      //     swift test ランナー / libdispatch worker は SIGHUP 等を block しているため、
      //     ここで明示的に空 mask に戻さないと kill(SIGHUP) が効かない。
      //
      // (2) signal disposition を SIG_DFL に戻す。
      //     `man 2 execve`: 「Signals set to be ignored in the calling process are
      //     set to be ignored in the new process.」 → SIG_IGN は execve でも継承される。
      //     親が SIG_IGN している signal も子側で default に戻す。
      var emptyMask = sigset_t()
      sigemptyset(&emptyMask)
      sigprocmask(SIG_SETMASK, &emptyMask, nil)

      signal(SIGHUP, SIG_DFL)
      signal(SIGINT, SIG_DFL)
      signal(SIGQUIT, SIG_DFL)
      signal(SIGTERM, SIG_DFL)
      signal(SIGPIPE, SIG_DFL)
      signal(SIGCHLD, SIG_DFL)

      chdir(cCwd)
      execve(cExecutable, argv, envp)
      _exit(127)
    }

    primaryFd = fd
    pid = childPid
    ptyTrace("spawn", pid: childPid, "forkpty returned fd=\(fd) executable=\(executable)")

    // 親側のコピーを開放（子は COW で別アドレス空間）。
    freeCStrings(argEntries, envEntries, cExecutable, cCwd, argv, envp)

    // master fd を non-blocking にする。drain loop が EAGAIN で止まれるようにし、
    // また exit handler 側からの drain が「データがなければ即抜ける」形で安全に呼べる。
    // write 側は既に EAGAIN を usleep + retry で扱っているので互換。
    let flags = fcntl(fd, F_GETFL)
    let getFlagsErrno: Int32 = flags == -1 ? errno : 0
    var setFlagsRet: Int32 = -1
    var setFlagsErrno: Int32 = 0
    if flags >= 0 {
      setFlagsRet = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
      if setFlagsRet == -1 { setFlagsErrno = errno }
    }
    ptyTrace(
      "spawn", pid: childPid,
      "fcntl getFlags=\(flags) getFlagsErrno=\(getFlagsErrno) setFlagsRet=\(setFlagsRet) setFlagsErrno=\(setFlagsErrno)"
    )

    // readSource / exitSource を **同じ per-PTY serial queue** に載せる。
    // 別 queue だと exit 通知が PTY master fd の残り出力 read より先に走るケースがあり、
    // PTYRegistry が `.exit` を yield して即 stream を finish する経路で最後の text が
    // 落ちる（onExit 後に onData が来る race）。同 queue + ガード（readClosed && exitReason
    // が両方揃ってから onExit を 1 度だけ呼ぶ）で「onExit は drain 済みを意味する」契約に揃える。
    let queue = DispatchQueue(label: "io.github.miyaoka.gozd.PTYManager.\(childPid)")
    let state = PTYFinishState(fd: fd)

    let source = DispatchSource.makeReadSource(
      fileDescriptor: fd,
      queue: queue
    )
    // self をキャプチャしないことで Sendable closure 制約を満たす。
    // 単発 read だと「event 1 回で data + EOF が同時に観測される」ケースで data を取りこぼす
    // 可能性があり、event coalescing による flaky の温床になる。drain loop で吸い切る。
    source.setEventHandler { [source] in
      ptyTrace("read", pid: childPid, "eventHandler fired")
      switch drainPTY(fd: fd, pid: childPid, caller: "read-source", onData: onData) {
      case .drained:
        return
      case .closed:
        ptyTrace("read", pid: childPid, "drain → .closed → cancel + markReadClosed")
        source.cancel()
        state.markReadClosed(pid: childPid, onComplete: onExit)
      }
    }
    // 注意: ここで close(fd) を呼ばない。exit handler 側の final drain が fd を読むため、
    // close は `PTYFinishState.tryFinish` の completion 時に 1 度だけ実行する。
    source.resume()
    ptyTrace("spawn", pid: childPid, "read source resumed")
    readSource = source

    // 子プロセスの exit 検知は kqueue ベースの DispatchSourceProcess を使う。
    let exit = DispatchSource.makeProcessSource(
      identifier: childPid,
      eventMask: .exit,
      queue: queue
    )
    exit.setEventHandler { [exit, source] in
      ptyTrace("exit", pid: childPid, "eventHandler fired (pre-waitpid drain)")
      // exit event と read readiness の到着順に依存しないよう、waitpid 前にも drain する。
      // 子はもう書かないので、ここで読める bytes は最終出力として確定。
      if case .closed = drainPTY(fd: fd, pid: childPid, caller: "exit-pre", onData: onData) {
        ptyTrace("exit", pid: childPid, "pre-drain → .closed → cancel + markReadClosed")
        source.cancel()
        state.markReadClosed(pid: childPid, onComplete: onExit)
      }

      // process source の exit handler 内では子は zombie 確定。`WNOHANG` を使うと
      // 戻り値 0（reap 未完）と exit code 0 の区別が曖昧になるため、blocking
      // waitpid + EINTR retry にして status を確実に回収する。
      // ECHILD（子が既に reap されている / 想定外）を見落とさないため、戻り値・errno・retry 回数を観測する。
      var status: Int32 = 0
      var waitRet: pid_t = 0
      var waitErrno: Int32 = 0
      var eintrRetries = 0
      while true {
        waitRet = waitpid(childPid, &status, 0)
        if waitRet != -1 {
          waitErrno = 0
          break
        }
        waitErrno = errno
        if waitErrno != EINTR { break }
        eintrRetries += 1
      }
      ptyTrace(
        "exit", pid: childPid,
        "waitpid ret=\(waitRet) status=\(status) errno=\(waitErrno) eintrRetries=\(eintrRetries)")
      let exitReason: PTYExitReason =
        waitRet == -1 ? .waitpidFailed(errno: waitErrno) : PTYExitReason.decode(status: status)

      // waitpid 後にもう一度 drain。exit と read の event 順序によらず最終 data を吸う。
      if case .closed = drainPTY(fd: fd, pid: childPid, caller: "exit-post", onData: onData) {
        ptyTrace("exit", pid: childPid, "post-drain → .closed → cancel + markReadClosed")
        source.cancel()
        state.markReadClosed(pid: childPid, onComplete: onExit)
      }

      state.setExitReason(exitReason, pid: childPid, onComplete: onExit)
      exit.cancel()
    }
    exit.resume()
    ptyTrace("spawn", pid: childPid, "exit source resumed")
    exitSource = exit
  }

  /// PTY master fd に書き込む（renderer → 子プロセスのキー入力等）。
  ///
  /// `write(2)` は短いバッファでも部分書き込みが起き得る（特に大きな paste や
  /// 連続入力）。全バイト書き切るまで loop し、`EINTR` は retry、`EAGAIN` /
  /// `EWOULDBLOCK` は短い sleep で待つ。`EPIPE` 等の致命的 errno は諦める。
  public func write(_ data: Data) {
    guard primaryFd >= 0 else { return }
    data.withUnsafeBytes { buffer in
      guard let base = buffer.baseAddress else { return }
      let total = buffer.count
      var written = 0
      while written < total {
        let n = Darwin.write(primaryFd, base.advanced(by: written), total - written)
        if n > 0 {
          written += n
          continue
        }
        let err = errno
        if err == EINTR { continue }
        if err == EAGAIN || err == EWOULDBLOCK {
          // PTY master は通常 blocking だが、念のため 1ms 待って retry。
          // busy-loop 暴走を避ける。
          usleep(1_000)
          continue
        }
        return
      }
    }
  }

  /// terminal サイズを子プロセスに通知する（xterm.js のリサイズ連動）。
  public func resize(rows: UInt16, cols: UInt16) {
    guard primaryFd >= 0 else { return }
    var ws = winsize(ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0)
    _ = ioctl(primaryFd, TIOCSWINSZ, &ws)
  }

  /// 子プロセスに SIGHUP を送る。SIGTERM は interactive zsh が無視するため不可。
  public func kill() {
    guard pid > 0 else { return }
    _ = Darwin.kill(pid, SIGHUP)
  }
}

public enum PTYError: Error, Equatable {
  case forkptyFailed(errno: Int32)
  /// `forkpty` 前段の strdup などで OOM 検出した場合。forkpty syscall 自体は呼ばれていない
  /// ので `forkptyFailed` を流用すると上位 log で失敗 syscall を取り違える。
  case preforkAllocFailed(errno: Int32)
}

public enum PTYExitReason: Sendable, Equatable {
  case exited(code: Int32)
  case signaled(signal: Int32, coreDumped: Bool)
  case stopped
  /// `waitpid(2)` が `-1` で失敗したケース（例: `ECHILD`）。
  /// `decode(status:)` に進ませると初期値 `status=0` が `.exited(code: 0)` と誤報されるため、
  /// 異常を呼び出し側まで伝搬する独立ケースとして用意する。
  case waitpidFailed(errno: Int32)

  /// `waitpid(2)` の status を `WIFEXITED` / `WIFSIGNALED` / `WIFSTOPPED` 相当で
  /// decode する。C マクロは Swift から不可視のため手動展開している。
  /// `CommandResolver` / `PTYManager` 双方の SSOT。
  public static func decode(status: Int32) -> PTYExitReason {
    let lower = status & 0x7F
    if lower == 0 {
      return .exited(code: (status >> 8) & 0xFF)
    }
    if lower == 0x7F {
      return .stopped
    }
    return .signaled(signal: lower, coreDumped: (status & 0x80) != 0)
  }
}

/// `PTYManager.spawn` の readSource / exitSource ハンドラ間で共有する終了確定状態。
/// 両ハンドラは同じ per-PTY serial queue に載っており、queue 自体が直列化を保証する。
/// それでも `@Sendable` クロージャに reference 型をキャプチャする以上、
/// Swift 6.2 の strict concurrency が Sendable を要求するため `@unchecked Sendable` を
/// 付ける。NSLock を併用して値変更を atomic にし、queue 直列化と二重防御にする。
///
/// finish の意味は「readClosed && exitReason」の両方が揃った時で、その時に 1 度だけ
/// `onComplete(reason)` を呼び、`fd` を close する。fd close をここに集約することで、
/// readSource cancel と exit handler の final drain が同 fd を競合 close する事故を避ける。
private final class PTYFinishState: @unchecked Sendable {
  private let lock = NSLock()
  private let fd: Int32
  private var readClosed = false
  private var exitReason: PTYExitReason?
  private var finished = false
  private var fdClosed = false

  init(fd: Int32) { self.fd = fd }

  /// fd を 1 度だけ close する。lock 保持の前提で呼ぶ。
  private func closeFdLocked() {
    if !fdClosed {
      fdClosed = true
      close(fd)
    }
  }

  func markReadClosed(pid: Int32 = 0, onComplete: (PTYExitReason) -> Void) {
    lock.lock()
    let alreadyReadClosed = readClosed
    readClosed = true
    let canFinish = !finished && exitReason != nil
    if canFinish { finished = true }
    let reason = exitReason
    if canFinish { closeFdLocked() }
    lock.unlock()
    ptyTrace(
      "fin", pid: pid,
      "markReadClosed alreadyReadClosed=\(alreadyReadClosed) exitReason=\(reason.map { "\($0)" } ?? "nil") canFinish=\(canFinish)"
    )
    if canFinish, let reason {
      ptyTrace("fin", pid: pid, "onComplete fired (via markReadClosed) reason=\(reason)")
      onComplete(reason)
    }
  }

  func setExitReason(
    _ reason: PTYExitReason, pid: Int32 = 0, onComplete: (PTYExitReason) -> Void
  ) {
    lock.lock()
    exitReason = reason
    let canFinish = !finished && readClosed
    if canFinish { finished = true }
    if canFinish { closeFdLocked() }
    let observedReadClosed = readClosed
    lock.unlock()
    ptyTrace(
      "fin", pid: pid,
      "setExitReason reason=\(reason) readClosed=\(observedReadClosed) canFinish=\(canFinish)")
    if canFinish {
      ptyTrace("fin", pid: pid, "onComplete fired (via setExitReason) reason=\(reason)")
      onComplete(reason)
    }
  }

  /// PTYManager が finish 前に解放された場合の保険。fd の double close は
  /// `fdClosed` フラグで防ぐ。
  deinit {
    if !fdClosed {
      close(fd)
    }
  }
}

/// PTY master fd から読める bytes を EAGAIN/EOF/EIO まで drain する。
/// non-blocking fd 前提。fd がまだ生きていれば `.drained`、close すべきなら `.closed`。
private enum PTYDrainResult {
  case drained
  case closed
}

private func drainPTY(fd: Int32, pid: Int32 = 0, caller: String = "?", onData: (Data) -> Void)
  -> PTYDrainResult
{
  // observer effect を最小化するため、ループ内では trace を呼ばず drain 終了時に
  // 集約結果を 1 行だけ出す。観測したい race（EVFILT_READ / NOTE_EXIT の到着順、
  // drain と exit の時間差）はループ内 I/O が増えるとそれ自体で潰れる。
  // 集約値: read 回数、合計バイト、EINTR 回数、終端区分（EOF / EAGAIN / hangup errno）。
  var totalBytes = 0
  var dataReads = 0
  var eintrCount = 0
  let result: PTYDrainResult
  let endReason: String
  drainLoop: while true {
    var buffer = [UInt8](repeating: 0, count: 4096)
    let n = buffer.withUnsafeMutableBufferPointer {
      Darwin.read(fd, $0.baseAddress, $0.count)
    }
    if n > 0 {
      totalBytes += n
      dataReads += 1
      onData(Data(bytes: buffer, count: n))
      continue
    }
    if n == 0 {
      result = .closed
      endReason = "EOF"
      break drainLoop
    }
    let err = errno
    if err == EINTR {
      eintrCount += 1
      continue
    }
    if err == EAGAIN || err == EWOULDBLOCK {
      result = .drained
      endReason = "EAGAIN"
      break drainLoop
    }
    // EIO 等は PTY hangup 扱い（slave 全 close）。再 read しても無意味なので closed として返す。
    result = .closed
    endReason = "hangup-errno=\(err)"
    break drainLoop
  }
  ptyTrace(
    "drain", pid: pid,
    "caller=\(caller) fd=\(fd) dataReads=\(dataReads) totalBytes=\(totalBytes) eintr=\(eintrCount) end=\(endReason) → \(result)"
  )
  return result
}


private func freeCStrings(
  _ argEntries: [UnsafeMutablePointer<CChar>?],
  _ envEntries: [UnsafeMutablePointer<CChar>?],
  _ cExecutable: UnsafeMutablePointer<CChar>?,
  _ cCwd: UnsafeMutablePointer<CChar>?,
  _ argv: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>,
  _ envp: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>
) {
  for p in argEntries { if let p { free(p) } }
  for p in envEntries { if let p { free(p) } }
  if let cExecutable { free(cExecutable) }
  if let cCwd { free(cCwd) }
  argv.deallocate()
  envp.deallocate()
}
