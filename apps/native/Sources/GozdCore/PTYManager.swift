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

    // 親側のコピーを開放（子は COW で別アドレス空間）。
    freeCStrings(argEntries, envEntries, cExecutable, cCwd, argv, envp)

    let source = DispatchSource.makeReadSource(
      fileDescriptor: fd,
      queue: .global(qos: .userInitiated)
    )
    // self をキャプチャしないことで Sendable closure 制約を満たす。
    source.setEventHandler { [source] in
      var buffer = [UInt8](repeating: 0, count: 4096)
      let n = buffer.withUnsafeMutableBufferPointer {
        read(fd, $0.baseAddress, $0.count)
      }
      if n > 0 {
        onData(Data(bytes: buffer, count: n))
        return
      }
      if n == 0 || (n == -1 && errno != EAGAIN && errno != EINTR) {
        source.cancel()
      }
    }
    source.setCancelHandler {
      close(fd)
    }
    source.resume()
    readSource = source

    // 子プロセスの exit 検知は kqueue ベースの DispatchSourceProcess を使う。
    //
    // blocking な `waitpid(pid, &status, 0)` を別スレッドで張る方式は libdispatch /
    // Foundation 内部の SIGCHLD 処理と競合する可能性があり、blocking thread を
    // 1 つ占有する。SwiftTerm（migueldeicaza）も DispatchSourceProcess + WNOHANG
    // で reap している。
    let exit = DispatchSource.makeProcessSource(
      identifier: childPid,
      eventMask: .exit,
      queue: .global(qos: .utility)
    )
    exit.setEventHandler { [exit] in
      var status: Int32 = 0
      // exit イベント発火後の reap。WNOHANG で blocking しない。
      waitpid(childPid, &status, WNOHANG)
      onExit(decodeExitStatus(status))
      exit.cancel()
    }
    exit.resume()
    exitSource = exit
  }

  /// PTY master fd に書き込む（renderer → 子プロセスのキー入力等）。
  public func write(_ data: Data) {
    guard primaryFd >= 0 else { return }
    _ = data.withUnsafeBytes { Darwin.write(primaryFd, $0.baseAddress, $0.count) }
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
}

public enum PTYExitReason: Sendable, Equatable {
  case exited(code: Int32)
  case signaled(signal: Int32, coreDumped: Bool)
  case stopped
}

private func decodeExitStatus(_ status: Int32) -> PTYExitReason {
  let lower = status & 0x7F
  if lower == 0 {
    return .exited(code: (status >> 8) & 0xFF)
  }
  if lower == 0x7F {
    return .stopped
  }
  return .signaled(signal: lower, coreDumped: (status & 0x80) != 0)
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
