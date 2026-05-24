import CPty
import Darwin
import Foundation

// openpty + fork + login_tty + DispatchSourceRead をラップする PTY マネージャー。
//
// 設計判断（spike `gozd-spike` で検証済み）:
//
// 1. **`@unchecked Sendable` を付けない**。non-Sendable class として単一 context（@MainActor
//    または専用 actor）から所有・操作する前提。FSWatcher と同じ流儀。
//
// 2. **read source の closure は self をキャプチャしない**。setEventHandler は
//    `@Sendable () -> Void` を要求するため、non-Sendable self を捕まえると Swift 6.2
//    strict concurrency 下でエラー。closure には `state: PTYFinishState`、`onData: @Sendable`、
//    `source` だけを渡し、EOF / read error 時は `source.cancel()` → state 経由で fd close。
//
// 3. **fork 子側は C 呼び出しのみ**。CPty.c の `gozd_pty_spawn` にまとめ、Swift 側に
//    子プロセスのコードは一切持たない。fork 後の async-signal-safe 違反の余地をゼロにする。
//
// 4. **kill は SIGHUP**。SIGTERM では interactive zsh が無視するため SIGHUP 固定
//    （spike で検証）。
//
// 5. **waitpid status decode は手動**。`WIFEXITED` 等の C マクロは Swift から不可視
//    のため、ビット演算で `.exited / .signaled / .stopped` を判別する。
//
// 6. **forkpty ではなく openpty + fork を使い、親側で slave fd を保持する**（issue #544）。
//    macOS xnu の tty driver は tty の最後の reference が release されると `ttyclose`
//    → `ttyflush(FREAD|FWRITE)` で **pending output queue を破棄** する。`/bin/echo`
//    のような ms 未満で `_exit` する child では、master fd が kqueue 経由で
//    `EVFILT_READ` を dispatch する前に slave 全 close（child の 3 references が
//    `_exit` で同時に drop）→ tty flush で 7 bytes が消える race が発生する。
//    親側で slave fd を 1 reference 持ち続けるアンカーを置けば、child `_exit` 後も
//    tty reference は 0 にならず ttyclose が走らない。`waitpid` で child の死亡を
//    確定し、master を drain し切ってから親が secondary fd を明示的に close すると
//    ようやく tty が close される（その時点で read queue は空なので flush 対象なし）。
//
// 7. **fd 状態は PTYFinishState に集約する（SSOT）**。primary / secondary fd の保持・
//    close 判定・write / resize / read source の close 後 race ガードを全て
//    `PTYFinishState` で行う。PTYManager 側は fd 番号を直接保持せず、`state` 経由で
//    操作する。close 後の操作は state 内 lock + フラグで silent に no-op に倒す。
public final class PTYManager {
  public typealias DataHandler = @Sendable (Data) -> Void
  public typealias ExitHandler = @Sendable (PTYExitReason) -> Void

  // `PTYRegistry.spawn` が `pidTracker.add(pty.pid)` で参照するため internal は必要。
  // モジュール外には露出しない（暗黙的 internal）。
  private(set) var pid: pid_t = -1
  private var state: PTYFinishState?
  private var readSource: DispatchSourceRead?
  private var exitSource: DispatchSourceProcess?
  // ready pipe 親側 read fd ( CPty.c の execve barrier )。`awaitReady` が 1 度だけ
  // blocking read + close する。spawn 失敗時 / awaitReady 後は -1 に倒す。`deinit`
  // で未消費なら fd リークを防ぐため close する。
  private var readyPipeFd: Int32 = -1

  public init() {}

  deinit {
    readSource?.cancel()
    exitSource?.cancel()
    if readyPipeFd >= 0 {
      close(readyPipeFd)
    }
  }

  /// 子プロセスが execve 段階に到達するまで blocking read で待つ。CPty.c の ready pipe
  /// ( 子が execve 直前に 1 byte 書き、_exit で kernel が close ) を 1 度だけ消費する。
  ///
  /// - read が 1 byte を返す: 子は login_tty + chdir 完了し execve 段階に到達。tty は
  ///   ready で、`write` / `resize` / 子からの input 経路が機能する状態
  /// - read が 0 byte ( EOF ) を返す: 子は execve 前に _exit ( login_tty / chdir 失敗 )。
  ///   `onExit` 経路で exit code (124 / 125) が配送されるので test 側はそちらを観測
  ///
  /// 二重呼び出しは safe ( 2 回目以降は `fd < 0` で即 return )。
  ///
  /// actor (`PTYRegistry`) から呼ぶときは class instance を await 越えに sending する
  /// ことになるため、`takeReadyPipeFd()` で fd を抽出してから自由関数 `awaitReadyPipe`
  /// に渡す経路を使う ( CLAUDE.md「`@unchecked Sendable` を付けない」規律 + Swift 6.2
  /// sending diagnostic 回避 )。本 method は PTYManager を直接保持する非 actor caller
  /// ( `PTYManagerTests` 等 ) 専用。
  public func awaitReady() async {
    await awaitReadyPipe(fd: takeReadyPipeFd())
  }

  /// ready pipe fd の所有権を caller に移譲する。1 度だけ呼べる accessor。
  /// `awaitReady` / `awaitReadyPipe` を経由する代わりに caller 自身で fd を消費する
  /// 経路 (`PTYRegistry.spawn` から actor 排他区間内で抽出 → 自由関数で blocking
  /// read) を作るために公開する。所有権が移った後の close 責務は caller 側にある
  /// (`awaitReadyPipe` 内 close か、caller の独自経路)。
  public func takeReadyPipeFd() -> Int32 {
    let fd = readyPipeFd
    readyPipeFd = -1
    return fd
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

    // openpty + fork + login_tty + execve を C 側にまとめて隔離する（CPty.c）。
    // `fork(2)` は Darwin SDK で Swift から直接呼べないため、C bridge 経由で呼ぶ必要が
    // ある。同時に、子側コードを完全に C に置くことで Swift runtime / ARC に触れる
    // 可能性をゼロにする。
    var ws = winsize(ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0)
    var masterFd: Int32 = -1
    var slaveFd: Int32 = -1
    var childPid: pid_t = -1
    var readyReadFd: Int32 = -1
    let spawnRet = gozd_pty_spawn(
      &masterFd,
      &slaveFd,
      &childPid,
      &readyReadFd,
      &ws,
      cExecutable,
      argv,
      envp,
      cCwd
    )
    // gozd_pty_spawn 戻り値: 0=成功 / -1=openpty 失敗 / -2=fork 失敗 / -3=pipe 失敗。
    // errno のみで判別すると EAGAIN を openpty / fork / pipe 全てが返し得るため
    // 取り違える。戻り値で syscall を確実に区別する。
    // 0/-1/-2/-3 以外は C bridge 側のバグなので `fatalError` で即座に落とす。
    // 「想定外なら fallback enum で握り潰す」設計だと観察可能性を失う。
    if spawnRet != 0 {
      let err = errno
      freeCStrings(argEntries, envEntries, cExecutable, cCwd, argv, envp)
      switch spawnRet {
      case -1: throw PTYError.openptyFailed(errno: err)
      case -2: throw PTYError.forkFailed(errno: err)
      case -3: throw PTYError.readyPipeFailed(errno: err)
      default:
        fatalError("gozd_pty_spawn returned unexpected code: \(spawnRet) (errno: \(err))")
      }
    }

    pid = childPid
    readyPipeFd = readyReadFd
    ptyTrace(
      "spawn", pid: childPid,
      "gozd_pty_spawn master=\(masterFd) slave=\(slaveFd) executable=\(executable)")

    // 親側のコピーを開放（子は COW で別アドレス空間）。
    freeCStrings(argEntries, envEntries, cExecutable, cCwd, argv, envp)

    // master fd を non-blocking にする。drain loop が EAGAIN で止まれるようにし、
    // また exit handler 側からの drain が「データがなければ即抜ける」形で安全に呼べる。
    // write 側は既に EAGAIN を usleep + retry で扱っているので互換。
    let flags = fcntl(masterFd, F_GETFL)
    let getFlagsErrno: Int32 = flags == -1 ? errno : 0
    var setFlagsRet: Int32 = -1
    var setFlagsErrno: Int32 = 0
    if flags >= 0 {
      setFlagsRet = fcntl(masterFd, F_SETFL, flags | O_NONBLOCK)
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
    let state = PTYFinishState(primaryFd: masterFd, secondaryFd: slaveFd, pid: childPid)
    self.state = state

    let source = DispatchSource.makeReadSource(
      fileDescriptor: masterFd,
      queue: queue
    )
    // self をキャプチャしないことで Sendable closure 制約を満たす。
    // 単発 read だと「event 1 回で data + EOF が同時に観測される」ケースで data を取りこぼす
    // 可能性があり、event coalescing による flaky の温床になる。drain loop で吸い切る。
    //
    // finish 経路の本筋は exit handler 側 (waitpid + closeSecondary + final drain 後の
    // markReadClosed)。設計判断 6 (親側で slave fd を 1 reference 保持) の下では、
    // `closeSecondary` が呼ばれる exit handler 内まで master の EOF は正常系で到達しない。
    // つまり read source 側で `.closed` を観測して markReadClosed を呼ぶのは、exit handler
    // 完了後に遅延配信される EOF event を受けた場合のための冗長化経路。
    // `alreadyReadClosed` / `finished` フラグで idempotent なので二重発火しても no-op。
    source.setEventHandler { [source, state] in
      ptyTrace("read", pid: childPid, "eventHandler fired")
      switch drainPTY(fd: masterFd, pid: childPid, caller: "read-source", onData: onData) {
      case .drained:
        return
      case .closed:
        ptyTrace("read", pid: childPid, "drain → .closed → cancel + markReadClosed")
        source.cancel()
        state.markReadClosed(onComplete: onExit)
      }
    }
    // 注意: ここで close(masterFd) を呼ばない。exit handler 側の final drain が fd を読むため、
    // close は `PTYFinishState` が finish 完了時に 1 度だけ実行する。
    source.resume()
    ptyTrace("spawn", pid: childPid, "read source resumed")
    readSource = source

    // 子プロセスの exit 検知は kqueue ベースの DispatchSourceProcess を使う。
    let exit = DispatchSource.makeProcessSource(
      identifier: childPid,
      eventMask: .exit,
      queue: queue
    )
    exit.setEventHandler { [exit, source, state] in
      ptyTrace("exit", pid: childPid, "eventHandler fired (pre-waitpid drain)")
      // exit event と read readiness の到着順に依存しないよう、waitpid 前にも drain する。
      // 親側で slave fd を保持しているため、この段階では EOF は来ない（EAGAIN が期待値）が、
      // child の死亡前に書かれた bytes は読める。
      _ = drainPTY(fd: masterFd, pid: childPid, caller: "exit-pre", onData: onData)

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

      // waitpid 直後にもう一度 drain。child の最終 write は kernel buffer まで届いており、
      // 親保持の slave fd のおかげで ttyflush で消されていない。ここで master を吸い切る。
      _ = drainPTY(fd: masterFd, pid: childPid, caller: "exit-post-waitpid", onData: onData)

      // ここで親側の slave fd を close する。tty reference が 0 になり ttyclose →
      // ttyflush が走るが、read queue は drain 済みなので flush 対象は空。
      // 直後の master read で EOF が観測できるようになる。
      state.closeSecondary()

      // **finish 経路は exit handler に一本化する**。次の 3 条件が揃った時点で master fd へ
      // 新規 data が到達することは原理的に無い:
      //
      //   1. waitpid 成功 → 子 reap 済み (writer 不在)
      //   2. closeSecondary → tty reference 0、ttyclose → ttyflush が走るが queue は既に空
      //   3. exit-final drain → EAGAIN または EOF (現時点で kernel buffer 空)
      //
      // 以前は exit-final が `.closed` の時のみ markReadClosed を呼び、`.drained` の場合は
      // 「read source が EOF を観測したら markReadClosed」に委ねていた。CI macOS-26 runner で
      // tty hangup 伝搬 (`closeSecondary` → master の NOTE_EOF) に 2 秒以上かかるケースが
      // 確認されており、その経路では onExit 配送が同分遅延する。
      // EOF event を待つ意味は無いので read source を即時 cancel + markReadClosed する。
      // 遅延配信される EOF event が read source handler に届いても、`markReadClosed` は
      // `alreadyReadClosed` フラグで idempotent なので no-op。
      let finalResult = drainPTY(
        fd: masterFd, pid: childPid, caller: "exit-final", onData: onData)
      ptyTrace(
        "exit", pid: childPid, "final-drain → \(finalResult) → cancel + markReadClosed")
      source.cancel()
      state.markReadClosed(onComplete: onExit)

      state.setExitReason(exitReason, onComplete: onExit)
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
  /// state 経由で書き込むことで、close 後 race で EBADF / 別 fd 誤書き込みを防ぐ。
  public func write(_ data: Data) {
    ptyTrace("api", pid: pid, "write called len=\(data.count) hasState=\(state != nil)")
    guard let state else { return }
    data.withUnsafeBytes { buffer in
      guard let base = buffer.baseAddress else { return }
      let total = buffer.count
      var written = 0
      while written < total {
        let result = state.write(base.advanced(by: written), len: total - written)
        switch result {
        case .closed:
          return
        case .wrote(let n):
          written += n
        case .retry(let err):
          if err == EAGAIN || err == EWOULDBLOCK {
            // PTY master は通常 blocking だが、念のため 1ms 待って retry。
            // busy-loop 暴走を避ける。
            usleep(1_000)
            continue
          }
          // EINTR は即時 retry
          if err == EINTR { continue }
          return
        }
      }
    }
  }

  /// terminal サイズを子プロセスに通知する（xterm.js のリサイズ連動）。
  public func resize(rows: UInt16, cols: UInt16) {
    ptyTrace(
      "api", pid: pid,
      "resize called rows=\(rows) cols=\(cols) hasState=\(state != nil)")
    state?.resize(rows: rows, cols: cols)
  }

  /// 子プロセスに SIGHUP を送る。SIGTERM は interactive zsh が無視するため不可。
  public func kill() {
    guard pid > 0 else {
      ptyTrace("api", pid: pid, "kill called but pid=\(pid) ≤ 0 → no-op")
      return
    }
    let ret = Darwin.kill(pid, SIGHUP)
    let err: Int32 = ret == -1 ? errno : 0
    ptyTrace("api", pid: pid, "kill(SIGHUP) ret=\(ret) errno=\(err)")
  }
}

public enum PTYError: Error, Equatable {
  /// `openpty(3)` の失敗（C bridge 戻り値 -1）。
  case openptyFailed(errno: Int32)
  /// `fork(2)` の失敗（C bridge 戻り値 -2）。
  case forkFailed(errno: Int32)
  /// ready pipe 作成 (`pipe(2)`) の失敗（C bridge 戻り値 -3）。execve barrier 用 pipe
  /// が用意できないと awaitReady が hang するため、ここで spawn を諦める。
  case readyPipeFailed(errno: Int32)
  /// spawn 前段の strdup などで OOM 検出した場合。spawn syscall 自体は呼ばれていないので
  /// `openptyFailed` / `forkFailed` を流用すると上位 log で失敗 syscall を取り違える。
  case preforkAllocFailed(errno: Int32)
}

extension PTYError: CustomStringConvertible {
  /// 上位 catch が `"\(error)"` や `String(describing:)` で文字列化したときに case 名と
  /// errno + strerror(3) が必ず残るようにする。Console.app log (stderr) と
  /// `RpcSchemeHandler` の 500 response payload の双方に同じ文字列が届く。
  public var description: String {
    switch self {
    case .openptyFailed(let errno):
      return "PTYError.openptyFailed(errno=\(errno) \(Self.errnoText(errno)))"
    case .forkFailed(let errno):
      return "PTYError.forkFailed(errno=\(errno) \(Self.errnoText(errno)))"
    case .readyPipeFailed(let errno):
      return "PTYError.readyPipeFailed(errno=\(errno) \(Self.errnoText(errno)))"
    case .preforkAllocFailed(let errno):
      return "PTYError.preforkAllocFailed(errno=\(errno) \(Self.errnoText(errno)))"
    }
  }

  /// errno → 人間可読文字列。`PTYError` / `PTYExitReason` 両方の `description`
  /// から共有するため `internal`。
  ///
  /// ## API 選択
  ///
  /// - `strerror(3)` は POSIX 文面上 thread-safe ではない（同一スレッド内で次回呼び出し
  ///   まで有効、別スレッドが同時に呼ぶと buffer が上書きされる）。よって thread-safe な
  ///   `strerror_r(3)` (POSIX 版、`int` 戻り) を使う
  /// - `swift-system` の `Errno.description` は内部で `strerror` を呼ぶ + 未解決の
  ///   thread-safety bug ( apple/swift-system #156 ) のため不採用
  /// - `Foundation.POSIXError` も NSError bridge 経由で内部実装は同根のため不採用
  /// - 文字列化は SE-0405 (`String(decoding:as: UTF8.self)` + `firstIndex(of: 0)` で
  ///   NUL truncate) の公式イディオムに従う。`String(cString: [CChar])` は Swift 6 で
  ///   deprecated（deprecation message: "after truncating the null termination"）。
  ///   `CChar` (Int8) → `UInt8` の bitPattern reinterpret で UTF-8 バイト列とみなす
  ///
  /// ## buffer / rc の扱い
  ///
  /// `strerror_r` の rc 値は捨てて buffer を返す。
  ///
  /// Darwin manpage strerror_r(3) は "If the error number is not recognized, these
  /// functions return EINVAL ... The strerror_r() function ... copies an error
  /// message string into the buffer ..." と明記しており、**invalid errno (EINVAL を
  /// 返す経路) でも buffer に readable な error message string を埋める** ことを
  /// 保証する。gozd は macOS 26 Tahoe 専用 (CLAUDE.md「対応プラットフォーム」) のため、
  /// Darwin 保証の範囲で挙動が閉じる。rc != 0 を理由に buffer を捨てると本物の
  /// strerror 出力 (renderer に届く identifier 品質、Console.app の人間可読性) を
  /// 失うため、buffer を信用する方針が観察可能性を最大化する。
  ///
  /// 非 ASCII バイト（0x80-0xFF）は許容する。`strerror_r` は `LC_MESSAGES` ロケール
  /// 依存（POSIX 仕様）で、`LANG=ja_JP.UTF-8` 等の環境では valid errno に対しても
  /// multi-byte UTF-8 シーケンスが buffer に書かれる。非 ASCII 構成バイトは観察ログの
  /// 1 行性を破壊しない（制御文字に重ならない）ため信頼する。これで stderr の 1 行性と
  /// renderer に届く identifier 品質の双方を同時に満たせる。
  ///
  /// ## 防御的 gate
  ///
  /// Darwin 保証は POSIX 未定義領域 (`rc != 0` 時 buffer 未定義) に依存しているため、
  /// 将来 version の挙動変化 / OS 内部状態の異常で「制御文字混入 buffer」が返る
  /// 可能性をゼロにできない（マルチスレッド race は `strerror_r` の POSIX 版が
  /// thread-safe なため脅威モデルから除外）。観察ログの 1 行性 (Console.app の grep
  /// 経路 / event 分離) を構造的に守るため、以下の条件で自前 fallback
  /// `"unknown errno N"` に倒す:
  ///
  /// - buffer が空（NUL のみ）
  /// - buffer に制御文字（CR/LF/TAB/NUL 等の 0x00-0x1F、DEL 0x7F）が含まれる
  ///
  /// gate のコストは spawn 失敗ごとの低頻度経路で無視できる。
  ///
  /// ## invalid UTF-8 sequence
  ///
  /// `String(decoding:as: UTF8.self)` は不正バイト列を U+FFFD (Unicode replacement
  /// character) に置換する。Darwin 保証範囲外の最悪ケース（制御文字を含まない
  /// 非 ASCII gibberish）で description に U+FFFD 混じりの文字列が乗る可能性がある。
  /// 観察ログ識別子として「errno N に対し非標準応答があった」として acceptable と
  /// 判定し、UTF-8 validity gate は入れない。
  ///
  /// validity gate を入れない理由は、非 UTF-8 ロケール（ISO-8859-1 / Shift_JIS 等の
  /// レガシー単 byte / non-UTF-8 multi-byte ロケール）で `strerror_r` が返す非 UTF-8
  /// 文字列を取りこぼす副作用を避けるため。現代 macOS の主要ロケール (UTF-8 ベース)
  /// では理論上の懸念だが、locale 依存性と観察可能性のバランスで U+FFFD 許容を選んだ。
  static func errnoText(_ code: Int32) -> String {
    var buf = [CChar](repeating: 0, count: errnoTextBufferSize)
    _ = strerror_r(code, &buf, buf.count)
    let nul = buf.firstIndex(of: 0) ?? buf.endIndex
    let slice = buf[..<nul]
    if slice.isEmpty {
      return "unknown errno \(code)"
    }
    // 制御文字 (0x00-0x1F, 0x7F) を含む buffer は観察ログの 1 行性を破壊するため
    // 信用しない。CChar (Int8) を UInt8 bitPattern で評価。multi-byte UTF-8 の
    // 構成バイト (0x80-0xFF) は許容して非英語 locale の strerror を保持する。
    let hasControlChar = slice.contains { c in
      let u = UInt8(bitPattern: c)
      return u < 0x20 || u == 0x7F
    }
    if hasControlChar {
      return "unknown errno \(code)"
    }
    return String(decoding: slice.lazy.map { UInt8(bitPattern: $0) }, as: UTF8.self)
  }

  /// `strerror_r` に渡す buffer のサイズ。実機の strerror 出力は Linux glibc で
  /// 100 byte 未満 / macOS Darwin でも 80 byte 程度に収まる。256 は将来の長文 errno
  /// (e.g. Darwin の "Cross-device link" 系) に対しても十分な余裕がある選択。
  /// ロケール依存の multi-byte UTF-8 では 1 文字あたり 1-4 バイトを消費するため
  /// ASCII 想定より緩衝が必要だが、256 はそれでも 2 倍以上のヘッドルームを確保する。
  /// test 側 mirror (`expectedErrnoText`) から参照するため `internal` で公開する
  /// (構造定数で運用 API としての副作用は無い)。
  internal static let errnoTextBufferSize = 256
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

extension PTYExitReason: CustomStringConvertible {
  /// `PTYError` と同じく、`"\(reason)"` / `String(describing:)` 経由で case 名 +
  /// 付随情報が必ず stderr / log に残るようにする。`waitpidFailed` は errno を
  /// 持つため `strerror_r(3)` 経由で人間可読化する。
  public var description: String {
    switch self {
    case .exited(let code):
      return "PTYExitReason.exited(code=\(code))"
    case .signaled(let signal, let coreDumped):
      return "PTYExitReason.signaled(signal=\(signal) coreDumped=\(coreDumped))"
    case .stopped:
      return "PTYExitReason.stopped"
    case .waitpidFailed(let errno):
      return "PTYExitReason.waitpidFailed(errno=\(errno) \(PTYError.errnoText(errno)))"
    }
  }
}

/// `PTYFinishState.write` の戻り値。
/// 旧来の `Int` 戻り値 + `errno` 経由通知より明示的にする。
enum PTYWriteResult {
  /// `n` バイト書き込めた（partial / full）。
  case wrote(Int)
  /// EINTR / EAGAIN / EWOULDBLOCK。`errno` を含める。呼び出し側が retry / sleep を判断する。
  case retry(Int32)
  /// fd は close 済み、または致命的 errno（EBADF / EPIPE 等）。呼び出し側は書き込みを諦める。
  case closed
}

/// `PTYManager.spawn` の readSource / exitSource ハンドラ間で共有する終了確定状態 + fd 所有者。
/// 両ハンドラは同じ per-PTY serial queue に載っており、queue 自体が直列化を保証する。
/// それでも `@Sendable` クロージャに reference 型をキャプチャする以上、
/// Swift 6.2 の strict concurrency が Sendable を要求するため `@unchecked Sendable` を
/// 付ける。NSLock を併用して値変更を atomic にし、queue 直列化と二重防御にする。
///
/// **SSOT**: primary (master) / secondary (slave) fd の保持・close 判定・write / resize の
/// race ガードを全てここで行う。`PTYManager` 側は fd 番号を持たず、本 state 経由で操作する。
/// これにより close 後に write が EBADF / 別 fd 誤書き込みするレースを防ぐ。
///
/// finish の意味は「readClosed && exitReason」の両方が揃った時で、その時に 1 度だけ
/// `onComplete(reason)` を呼び、`primaryFd` を close する。
///
/// `secondaryFd` は親側で保持する slave fd。child の `_exit` で tty reference が 0 に
/// なって ttyflush で出力が drop するのを防ぐアンカー（issue #544 / 方針 A）。
/// `closeSecondary` で exit handler が drain 済みのタイミングで close する。leak を防ぐ
/// ため `deinit` でも未 close なら state 経由で close する（lock + フラグで double close 防ぐ）。
final class PTYFinishState: @unchecked Sendable {
  private let lock = NSLock()
  private let primaryFd: Int32
  private let secondaryFd: Int32
  /// trace ログの pid タグに使う。caller 側で毎回引数で渡す重複を排除し、各 trace 行
  /// （write 含む）で同一の pid が出力される一貫性を保証する。
  private let pid: Int32
  private var readClosed = false
  private var exitReason: PTYExitReason?
  private var finished = false
  private var primaryClosed = false
  private var secondaryClosed = false

  init(primaryFd: Int32, secondaryFd: Int32, pid: Int32) {
    self.primaryFd = primaryFd
    self.secondaryFd = secondaryFd
    self.pid = pid
  }

  /// primary (master) fd を 1 度だけ close する。lock 保持の前提で呼ぶ。
  private func closePrimaryLocked() {
    if !primaryClosed {
      primaryClosed = true
      close(primaryFd)
    }
  }

  /// secondary (slave) fd を 1 度だけ close する。tty の最後の reference を release し、
  /// ttyclose → ttyflush を起こす。drain 済みのタイミングで呼べば flush 対象は空。
  func closeSecondary() {
    lock.lock()
    let closedNow = !secondaryClosed
    if closedNow {
      secondaryClosed = true
      close(secondaryFd)
    }
    lock.unlock()
    ptyTrace("fin", pid: pid, "closeSecondary fd=\(secondaryFd) closed-now=\(closedNow)")
  }

  /// `PTYManager.write` から呼ぶ writer。close 済みなら `.closed` を返す。
  /// EAGAIN / EINTR / EWOULDBLOCK は `.retry(errno)`、それ以外の致命的 errno は `.closed` に
  /// 倒す（write 経路で EBADF / EPIPE / EIO を観測したら以後の write は意味が無い）。
  /// 致命的 errno と `n == 0`（POSIX 上未定義動作）は `ptyTrace` で観測可能に残す。
  /// silent に `.closed` に倒すと「write が永続的に何も書かなくなった」事象を後追いできない。
  ///
  /// trace は lock 開放後に出す。`ptyTrace` は内部で別 lock を取るため、`PTYFinishState.lock`
  /// を保持したまま呼ぶと潜在的なロック順序違反になる（closeSecondary も同じ形を採用）。
  /// lock 内本処理は `writeLocked` に切り出し、本関数は lock + 呼び出し + unlock + trace の
  /// フラットな構造に保つ（CLAUDE.md「if-else の分岐は関数に切り出す」）。
  func write(_ ptr: UnsafeRawPointer, len: Int) -> PTYWriteResult {
    lock.lock()
    let (result, traceMessage) = writeLocked(ptr, len: len)
    lock.unlock()
    if let traceMessage {
      ptyTrace("write", pid: pid, traceMessage)
    }
    return result
  }

  /// `write` の lock 保持中処理。早期 return で if-else ネストを潰すため切り出した。
  /// 戻り値の 2 要素目は trace に残すべきメッセージ（nil なら trace 出力なし）。
  /// 呼び出し側で lock を取得済みであること。
  private func writeLocked(_ ptr: UnsafeRawPointer, len: Int) -> (PTYWriteResult, String?) {
    if primaryClosed { return (.closed, nil) }
    let n = Darwin.write(primaryFd, ptr, len)
    if n > 0 { return (.wrote(n), nil) }
    if n == 0 {
      // POSIX 上 write が 0 を返すのは未定義。観測できるよう trace に残す。
      return (
        .closed,
        "Darwin.write returned 0 (POSIX undefined) fd=\(primaryFd) len=\(len) → closed"
      )
    }
    let err = errno
    if err == EINTR || err == EAGAIN || err == EWOULDBLOCK {
      return (.retry(err), nil)
    }
    // EBADF / EPIPE / EIO 等の致命的 errno。caller 側で観測できないため trace を残す。
    return (.closed, "fatal errno=\(err) fd=\(primaryFd) len=\(len) → closed")
  }

  /// terminal サイズ通知。close 済みなら no-op。
  /// ioctl の戻り値・errno は trace に残す。「resize 呼び出しが届いたが ioctl が EBADF を返した」
  /// 経路を後追いするには戻り値の観測が必須。silent 失敗だと CI ログから判別不能になる。
  func resize(rows: UInt16, cols: UInt16) {
    lock.lock()
    if primaryClosed {
      lock.unlock()
      ptyTrace(
        "fin", pid: pid,
        "resize rows=\(rows) cols=\(cols) primaryClosed → no-op")
      return
    }
    var ws = winsize(ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0)
    let ret = ioctl(primaryFd, TIOCSWINSZ, &ws)
    let err: Int32 = ret == -1 ? errno : 0
    lock.unlock()
    ptyTrace(
      "fin", pid: pid,
      "resize fd=\(primaryFd) rows=\(rows) cols=\(cols) ioctl ret=\(ret) errno=\(err)")
  }

  func markReadClosed(onComplete: (PTYExitReason) -> Void) {
    lock.lock()
    let alreadyReadClosed = readClosed
    readClosed = true
    let canFinish = !finished && exitReason != nil
    if canFinish { finished = true }
    let reason = exitReason
    if canFinish { closePrimaryLocked() }
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
    _ reason: PTYExitReason, onComplete: (PTYExitReason) -> Void
  ) {
    lock.lock()
    exitReason = reason
    let canFinish = !finished && readClosed
    if canFinish { finished = true }
    if canFinish { closePrimaryLocked() }
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

  /// PTYManager が finish 前に解放された場合の保険。double close は各フラグで防ぐ。
  /// `deinit` は ARC 経由で任意の thread から呼ばれ得るため、lock を取って flag を見て
  /// から close する（直接 close すると finish 経路と double close の余地が残る）。
  deinit {
    lock.lock()
    let primaryNeedsClose = !primaryClosed
    let secondaryNeedsClose = !secondaryClosed
    if primaryNeedsClose { primaryClosed = true }
    if secondaryNeedsClose { secondaryClosed = true }
    lock.unlock()
    if primaryNeedsClose { close(primaryFd) }
    if secondaryNeedsClose { close(secondaryFd) }
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


/// ready pipe fd を消費して 1 byte ( or EOF ) を待つ自由関数。`PTYManager.awaitReady`
/// と `PTYRegistry.spawn` の両方から呼ばれる SSOT。
///
/// blocking read は dedicated NSThread 上で実行し、Swift Concurrency cooperative
/// executor / GCD pool / kqueue いずれの dispatch 経路にも乗せない。`Continuation` の
/// resume は read + close 完了時の 1 回のみ。
///
/// `fd < 0` ( 未保持 / 既消費 ) なら即 return。fd は所有権が caller から渡された前提で、
/// 本関数が close 責務を負う。
func awaitReadyPipe(fd: Int32) async {
  if fd < 0 { return }
  await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
    let thread = Thread {
      var buf: UInt8 = 0
      while true {
        let n = Darwin.read(fd, &buf, 1)
        if n == -1 && errno == EINTR { continue }
        break
      }
      Darwin.close(fd)
      continuation.resume()
    }
    thread.name = "PTYAwaitReady"
    thread.start()
  }
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
