import Darwin
import Foundation
import os

// `Process` を `git` / `gh` 等の外部 CLI 起動に使うときの共通基盤。
//
// 解決すべき 3 つの問題:
//
// 1. **PATH 不足**: `.app` を Finder/Dock から起動すると launchd 経由で渡される PATH は
//    `/usr/bin:/bin:/usr/sbin:/sbin` のみ。Homebrew (`/opt/homebrew/bin`) や mise / asdf
//    配下の CLI は解決できない。`git` は `/usr/bin/git` の Apple stub に救われるが
//    `gh` は救われない。dev (`pnpm dev`) ではターミナル PATH を継承するので顕在化しない。
//
// 2. **`.app` 子プロセスでの zsh `-i` hang**: `Foundation.Process` で `zsh -i -l -c` を
//    spawn すると、子は親 `.app` の process group を継承する。`.app` プロセスは
//    controlling tty を持たないため、子 zsh の interactive モード初期化（job control:
//    `tcsetpgrp` / `tcgetpgrp` 系）が blocking syscall で永久 hang する。stdout/stderr
//    に 1 文字も出ないまま固まる。`POSIX_SPAWN_SETSID` で子を新 session leader に
//    切り離せば、self-consistent な状態で job control が初期化されて hang しない。
//    VSCode の `child_process.spawn({detached: true})` も libuv 経由 `setsid()` で
//    同等の対策をしている。
//
// 3. **pipe drain の deadlock**: `terminationHandler` 内で `readDataToEndOfFile()` する
//    naive 実装は出力が macOS の pipe buffer (~64KB) を超えると子プロセスが
//    write block → exit 不能 → terminationHandler 永遠に呼ばれない deadlock を起こす。
//
// `CommandResolver` で 1 + 2 を、`runProcessCollectingOutput` で 3 を解決する。

// MARK: - CommandResolver

/// 外部 CLI の絶対パスを解決してキャッシュする actor。
///
/// 解決手順: **ユーザーログインシェル経由でのみ解決する**。
/// `getpwuid_r(getuid())->pw_shell` でユーザーのログインシェルを取得し、
/// `<shell> -i -l -c '<script>'` で起動して `command -v <name>` の絶対パスを得る。
/// これが「ユーザーがターミナルで叩く時に使われる CLI」と一致する唯一の経路。
///
/// `-i -l` 両方付ける理由: `mise activate` / `asdf` 等は `.zshrc` 経由で activate
/// されるケースが多く、`-l` (login) 単独では `.zshrc` を読まない。VSCode の
/// shell environment resolver も同じ理由で `-i -l -c` を採用している。
///
/// **`POSIX_SPAWN_SETSID` で spawn する理由**: `.app` プロセス自身が controlling tty を
/// 持たないため、子 zsh が `-i` の job control 初期化（`tcsetpgrp` 系）で永久 hang する。
/// 子を新 session に切り離すことで session leader として self-consistent な状態になり
/// hang しない。詳細はファイル冒頭コメント参照。`Foundation.Process` は `POSIX_SPAWN_SETSID`
/// を公開 API で立てる手段が無いため、`posix_spawn` を直接呼ぶ。
///
/// 結果は alias / function ではなく絶対パスかつ executable であることを検証する。
///
/// **現プロセス PATH を使わない理由**: macOS の `/usr/bin/<dev tool>` は libxcselect
/// 経由の shim で、Homebrew / mise / Apple stub のいずれも別バイナリ。Finder/Dock 起動の
/// `.app` は launchd PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) しか継承しないため、現
/// プロセス PATH を解決手段に混ぜると Apple stub が必ず先頭マッチして「ターミナルでは
/// Homebrew git、`.app` では Apple stub」という非対称が生じる。Keychain ACL が binary
/// path に紐付くため、認証情報も別世界扱いになる（ターミナルで作った credential が
/// `.app` から見えない）。ログインシェル経由なら CLT only / Homebrew / mise どの層
/// でも「ユーザーが普段使う CLI」を返すので、この非対称が原理的に発生しない。
///
/// **fallback を持たない理由**: macOS の `getpwuid_r` は `pw_shell` が欠落していても
/// `/usr/bin/false` 等の default を供給するため、login user で shell が取れない状態は
/// 実用上発生しない。残る失敗ケース（exotic shell で `-i -l -c '<cmd>'` を解釈しない
/// 等）は「ユーザーが意図的に exotic 環境を選んだ」状態で、ここで silent に
/// `/usr/bin/<tool>` に倒す方がユーザー意図と乖離する。解決失敗時は `launchFailed` を
/// 投げて呼び出し側 (notify.error) に通知する方が筋が良い。
///
/// 解決結果は actor 内のキャッシュに保存する。`invalidate(_:)` で無効化することで
/// stale cache（mise/asdf upgrade で versioned path が消えた等）に再解決の余地を残す。
public actor CommandResolver {
  public static let shared = CommandResolver()

  /// テスト用の shell オーバーライド。`nil` のとき本番経路 (`userLoginShell()`) を使う。
  /// `sh` / `dash` / `tcsh` 等の別シェルで SETSID 経路でも hang しない / 解決できることを
  /// 自動検証するために `init` から注入できる。本番 (shared) では使わない。
  private let shellOverride: String?

  /// 本番用 (shared) は引数なし init。テストでは `CommandResolver(shellOverride:)` で
  /// shell バイナリを差し替えられる。
  public init(shellOverride: String? = nil) {
    self.shellOverride = shellOverride
  }

  /// 解決失敗 (`pw_shell` 取得不能 / `command -v` 不解釈 / job control hang / SIGKILL
  /// タイムアウト / marker 抽出失敗 等) の事実を Console.app から追えるよう
  /// `os.Logger` で記録する。失敗時にユーザーには `launchFailed` としか見えないため、
  /// ここでサブ原因を残しておかないと事後分析できない。
  private static let logger = Logger(subsystem: "dev.miyaoka.gozd", category: "command-resolver")

  private var cache: [String: String] = [:]
  /// 未インストール結果の negative cache。`command -v` が exit=0 で空を返したケース。
  /// 毎回 zsh `-i -l -c` を spawn する性能負債を防ぐため、後から `invalidate` で外す API
  /// を経由して再 resolve できる。spawn 失敗 / hang はキャッシュしない（throws で抜ける）。
  private var negativeCache: Set<String> = []
  private var inflight: [String: Task<String?, Error>] = [:]

  /// 指定 name の絶対パスを返す。`command -v` の結果が空（コマンド未インストール）なら nil。
  /// shell spawn 失敗 / hang / 起動エラーなどは `GitError.launchFailed` を throw する。
  /// 結果はキャッシュされる（positive / negative どちらも）。
  public func resolve(_ name: String) async throws -> String? {
    if let cached = cache[name] { return cached }
    if negativeCache.contains(name) { return nil }
    if let inflight = inflight[name] { return try await inflight.value }

    let shellPath = shellOverride ?? Self.userLoginShell()
    let task = Task<String?, Error> { try await Self.lookup(name, shell: shellPath) }
    inflight[name] = task
    do {
      let result = try await task.value
      inflight[name] = nil
      if let result {
        cache[name] = result
      } else {
        negativeCache.insert(name)
      }
      return result
    } catch {
      inflight[name] = nil
      throw error
    }
  }

  /// キャッシュ（positive / negative 両方）を無効化する。
  /// `runGit` / `runGh` が `launchFailed` を受けたとき、または「未インストールだった
  /// コマンドを後からインストールした」ときに呼ぶ。
  public func invalidate(_ name: String) {
    cache[name] = nil
    negativeCache.remove(name)
  }

  private static func lookup(_ name: String, shell: String) async throws -> String? {
    return try await lookupViaLoginShell(name, shell: shell)
  }

  /// `getpwuid_r(getuid())->pw_shell` でユーザーのログインシェルを取得。
  /// `getpwuid` は thread-unsafe（共有 buffer を返す）なので reentrant 版を使う。
  /// 取れない場合は `$SHELL` → `/bin/zsh` の順で fallback。
  private static func userLoginShell() -> String {
    let suggested = sysconf(_SC_GETPW_R_SIZE_MAX)
    let bufSize: Int = suggested > 0 ? Int(suggested) : 4096
    var buffer = [CChar](repeating: 0, count: bufSize)
    var pwd = passwd()
    var result: UnsafeMutablePointer<passwd>? = nil
    let rc = getpwuid_r(getuid(), &pwd, &buffer, bufSize, &result)
    if rc == 0, result != nil {
      let shellPtr: UnsafeMutablePointer<CChar>? = pwd.pw_shell
      if let shellPtr {
        let shell = String(cString: shellPtr)
        if !shell.isEmpty {
          return shell
        }
      }
    }
    if let envShell = ProcessInfo.processInfo.environment["SHELL"], !envShell.isEmpty {
      return envShell
    }
    return "/bin/zsh"
  }

  /// `posix_spawn + POSIX_SPAWN_SETSID` で `<shell> -i -l -c '<script>'` を起動して
  /// `command -v <name>` の絶対パスを取得する。
  ///
  /// `Foundation.Process` を使わない理由は本ファイル冒頭コメント (2) 参照: `.app` 子から
  /// 素の `Process` で `zsh -i` を起動すると親の process group / 不在 controlling tty を
  /// 継承して job control 初期化で hang する。`POSIX_SPAWN_SETSID` で子を新 session leader に
  /// 切り離すことで hang しない。VSCode `child_process.spawn({detached: true})` と同等。
  ///
  /// 観察可能な強制中断: 子 shell が想定外で hang した場合に永久ローディングを防ぐため、
  /// 10 秒で SIGKILL する。これは「症状を覆い隠す silent fallback」ではなく
  /// 「症状を error として表面化させる強制中断」であり、観察可能性に寄与する。
  /// 発火時は logger に詳細を残してから nil 返却 → 呼び出し側で `launchFailed` 化される。
  ///
  /// rc ファイルが stdout に流す余計な文字列に備えて UUID marker で囲んで抽出する。
  /// 親 stdin の継承を防ぐべく `/dev/null` を子の stdin に dup2 する。
  ///
  /// 対応シェル: `-i -l -c` フラグおよび POSIX `command -v` を解釈する shell（bash / zsh /
  /// dash / fish 等）を想定。tcsh / nushell / xonsh の一部呼び出し方法は不対応。
  ///
  /// 戻り値: `command -v` の結果が空（コマンド未インストール）の場合のみ nil。
  /// shell の spawn 失敗 / hang / 起動エラーなどは `GitError.launchFailed` を throw する。
  private static func lookupViaLoginShell(_ name: String, shell: String) async throws -> String? {
    // shell 注入境界: `name` を bash/zsh の script 文字列内に補間するため、ASCII の英数と
    // ハイフン / アンダースコアに限定する。`runGit` / `runGh` などコード内リテラル経路では
    // 問題ないが、API 表面（public actor）のセキュリティ境界をここで固める。
    // `Character.isLetter` / `.isNumber` は Unicode 全文字を許可するため `isASCII` で絞る
    // （絵文字 / 全角数字 / ギリシャ文字経由の境界突破を防ぐ）。
    guard !name.isEmpty,
      name.allSatisfy({
        $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_")
      })
    else {
      throw GitError.launchFailed(
        "resolve: invalid command name '\(name)' (must match ASCII [A-Za-z0-9_-]+)")
    }

    let token = UUID().uuidString
    let beginMarker = "GOZD_BEGIN_\(token)"
    let endMarker = "GOZD_END_\(token)"
    let script =
      "printf '%s\\n' \(beginMarker); command -v \(name); printf '%s\\n' \(endMarker)"
    let args = ["-i", "-l", "-c", script]

    // stdin /dev/null
    let devNullFd = open("/dev/null", O_RDONLY)
    guard devNullFd >= 0 else {
      let e = errno
      logger.error("lookupViaLoginShell: /dev/null open failed errno=\(e, privacy: .public)")
      throw GitError.launchFailed("CLI resolver: open(/dev/null) failed errno=\(e)")
    }
    defer { close(devNullFd) }

    // stdout pipe を先に作る。stderr pipe 失敗時に stdout fd をリークしないよう、
    // 個別に guard + cleanup する。
    var stdoutPipeFds: [Int32] = [-1, -1]
    guard pipe(&stdoutPipeFds) == 0 else {
      let e = errno
      logger.error("lookupViaLoginShell: stdout pipe() failed errno=\(e, privacy: .public)")
      throw GitError.launchFailed("CLI resolver: stdout pipe() failed errno=\(e)")
    }
    var stderrPipeFds: [Int32] = [-1, -1]
    guard pipe(&stderrPipeFds) == 0 else {
      let e = errno
      close(stdoutPipeFds[0])
      close(stdoutPipeFds[1])
      logger.error("lookupViaLoginShell: stderr pipe() failed errno=\(e, privacy: .public)")
      throw GitError.launchFailed("CLI resolver: stderr pipe() failed errno=\(e)")
    }
    let stdoutR = stdoutPipeFds[0], stdoutW = stdoutPipeFds[1]
    let stderrR = stderrPipeFds[0], stderrW = stderrPipeFds[1]
    defer {
      close(stdoutR)
      close(stderrR)
    }

    // 子の fd 設定 (stdin=devNullFd, stdout=stdoutW, stderr=stderrW)。
    // posix_spawn_file_actions_* の戻り値も全て確認する。`adddup2` が失敗すると
    // 子の fd 配線が指定通りにならず、stdout/stderr drain が EOF を受け取れず hang する。
    var fileActions = posix_spawn_file_actions_t(bitPattern: 0)
    var rc = posix_spawn_file_actions_init(&fileActions)
    guard rc == 0 else {
      close(stdoutW)
      close(stderrW)
      logger.error(
        "lookupViaLoginShell: file_actions_init failed rc=\(rc, privacy: .public)")
      throw GitError.launchFailed("CLI resolver: posix_spawn_file_actions_init failed rc=\(rc)")
    }
    defer { posix_spawn_file_actions_destroy(&fileActions) }
    for (srcFd, dstFd) in [
      (devNullFd, STDIN_FILENO), (stdoutW, STDOUT_FILENO), (stderrW, STDERR_FILENO),
    ] {
      rc = posix_spawn_file_actions_adddup2(&fileActions, srcFd, dstFd)
      guard rc == 0 else {
        close(stdoutW)
        close(stderrW)
        logger.error(
          "lookupViaLoginShell: file_actions_adddup2 failed rc=\(rc, privacy: .public)")
        throw GitError.launchFailed(
          "CLI resolver: posix_spawn_file_actions_adddup2 failed rc=\(rc)")
      }
    }

    // POSIX_SPAWN_SETSID: 子を新 session leader に切り離す。本実装の核心。
    // setflags が silent に失敗すると SETSID が立たないまま spawn 成功 → 親 process group の
    // ままで zsh `-i` 起動 → 元の hang 経路に再突入する。戻り値を必ず確認する。
    var attr = posix_spawnattr_t(bitPattern: 0)
    rc = posix_spawnattr_init(&attr)
    guard rc == 0 else {
      close(stdoutW)
      close(stderrW)
      logger.error("lookupViaLoginShell: spawnattr_init failed rc=\(rc, privacy: .public)")
      throw GitError.launchFailed("CLI resolver: posix_spawnattr_init failed rc=\(rc)")
    }
    defer { posix_spawnattr_destroy(&attr) }
    // Int16 overflow を fatalError trap させない。POSIX_SPAWN_SETSID が将来複合フラグに
    // 変わって 32767 を超えたら exactly: が nil を返して explicit な error 経路に乗る。
    guard let flagsInt16 = Int16(exactly: POSIX_SPAWN_SETSID) else {
      close(stdoutW)
      close(stderrW)
      logger.error("lookupViaLoginShell: POSIX_SPAWN_SETSID does not fit in Int16")
      throw GitError.launchFailed("CLI resolver: POSIX_SPAWN_SETSID flag overflow")
    }
    rc = posix_spawnattr_setflags(&attr, flagsInt16)
    guard rc == 0 else {
      close(stdoutW)
      close(stderrW)
      logger.error(
        "lookupViaLoginShell: spawnattr_setflags failed rc=\(rc, privacy: .public)")
      throw GitError.launchFailed(
        "CLI resolver: posix_spawnattr_setflags failed rc=\(rc) (POSIX_SPAWN_SETSID not applied)")
    }

    // argv[0] は絶対パスを渡す。zsh / bash とも `-l` フラグ単独で login shell として
    // 動作することが man で保証されているため、`-zsh` 慣例 (argv[0] を `-` プレフィクスに
    // する macOS Terminal.app の流儀) には合わせない。login shell 判定は argv[0] と
    // フラグの OR で、`-l` がある以上どちらかは確実に立つ。
    let argv = [shell] + args
    let cArgv: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) } + [nil]
    defer { for ptr in cArgv { if let p = ptr { free(p) } } }
    // strdup 失敗 (OOM) を検出する。nil が混入したまま posix_spawn に渡すと argv が短く
    // terminate されて子が想定外の状態で起動する。OOM 状態は他も壊れる極端ケースだが、
    // silent に異常 spawn する経路は塞ぐ。
    guard !cArgv.dropLast().contains(where: { $0 == nil }) else {
      close(stdoutW)
      close(stderrW)
      logger.error("lookupViaLoginShell: strdup(argv) returned nil (OOM)")
      throw GitError.launchFailed("CLI resolver: strdup(argv) failed (OOM)")
    }

    // env: 親プロセス env から gozd 起源キー (`ZDOTDIR` / `GOZD_DEV_*`) を除去する。
    // PTY spawn と同じ deny-list (`GozdEnvOverlay.sanitizeParentEnv`) を SSOT として使い、
    // 子 zsh が gozd の zsh init チェーンに巻き込まれないようにする。
    let env = GozdEnvOverlay.sanitizeParentEnv(ProcessInfo.processInfo.environment)
    let cEnvp: [UnsafeMutablePointer<CChar>?] =
      env.map { strdup("\($0.key)=\($0.value)") } + [nil]
    defer { for ptr in cEnvp { if let p = ptr { free(p) } } }
    guard !cEnvp.dropLast().contains(where: { $0 == nil }) else {
      close(stdoutW)
      close(stderrW)
      logger.error("lookupViaLoginShell: strdup(envp) returned nil (OOM)")
      throw GitError.launchFailed("CLI resolver: strdup(envp) failed (OOM)")
    }

    var pid: pid_t = 0
    let spawnResult = posix_spawn(&pid, shell, &fileActions, &attr, cArgv, cEnvp)
    let spawnErrno = errno
    // 親側の write end は子に dup2 された後は不要。close することで子の exit 後に
    // pipe の read 側が EOF を受け取れる。
    close(stdoutW)
    close(stderrW)
    guard spawnResult == 0 else {
      logger.error(
        """
        lookupViaLoginShell: posix_spawn failed shell='\(shell, privacy: .public)' \
        rc=\(spawnResult, privacy: .public) errno=\(spawnErrno, privacy: .public)
        """)
      throw GitError.launchFailed(
        "CLI resolver: posix_spawn '\(shell)' failed rc=\(spawnResult) errno=\(spawnErrno)")
    }

    // stdout/stderr を非同期 drain。子が pipe buffer を超えて書くと write block するため、
    // EOF まで読み続ける別 Task に分離。
    async let stdoutData: Data = readAllFromFd(stdoutR)
    async let stderrData: Data = readAllFromFd(stderrR)

    // 観察可能な強制中断: 10 秒で SIGKILL。session leader なので自分自身は確実に殺せる。
    // タイムアウトは「症状を覆い隠す silent fallback」ではなく「症状を error として
    // 表面化させる強制中断」。発火時は launchFailed のテキストで renderer まで届ける。
    //
    // 10 秒の根拠: 重い `.zshrc` (mise activate + starship init + brew shellenv + 補完初期化)
    // でも通常 1〜2 秒。CI 環境の cold cache や Spotlight indexing 中の I/O 待ちを加味して
    // 5 倍のマージン。これを超える rc 構成は実用上 hang と同義（ユーザーが毎回 5 秒以上
    // 待たされる体験）であり、SIGKILL してエラー表示した方が原因特定に向く。VSCode の
    // `application.shellEnvironmentResolutionTimeout` も default 10 秒で同じ判断。
    let timedOutFlag = OSAllocatedUnfairLock<Bool>(initialState: false)
    let timeoutTask = Task { [pid] in
      try? await Task.sleep(nanoseconds: 10 * 1_000_000_000)
      if kill(pid, 0) == 0 {
        timedOutFlag.withLock { $0 = true }
        _ = kill(pid, SIGKILL)
      }
    }
    defer { timeoutTask.cancel() }

    // waitpid は EINTR でループする。`PTYManager` と同じ流儀。
    let (waitRet, status, waitErrno): (Int32, Int32, Int32) =
      await Task.detached(priority: .userInitiated) { [pid] in
        var s: Int32 = 0
        while true {
          let r = waitpid(pid, &s, 0)
          if r == -1 && errno == EINTR { continue }
          return (r, s, errno)
        }
      }.value

    let stdoutBytes = await stdoutData
    let stderrBytes = await stderrData
    let timedOut = timedOutFlag.withLock { $0 }

    guard waitRet >= 0 else {
      logger.error(
        """
        lookupViaLoginShell: waitpid failed pid=\(pid, privacy: .public) \
        errno=\(waitErrno, privacy: .public)
        """)
      throw GitError.launchFailed("CLI resolver: waitpid failed errno=\(waitErrno)")
    }

    let exitReason = PTYExitReason.decode(status: status)
    switch exitReason {
    case .exited(let code) where code == 0:
      break  // 成功経路。下で marker 抽出へ
    default:
      // 失敗時は stderr 末尾 4KB を Console に残す。trace モード（zsh `-x`）でなくても、
      // shell rc が出した警告 / hang 直前の出力を事後分析できる。
      let stderrTail = String(String(decoding: stderrBytes, as: UTF8.self).suffix(4096))
      let reasonDesc: String
      if timedOut {
        reasonDesc =
          "timed out (10s) and was SIGKILL'd — shell rc may be hanging in an unexpected way"
      } else {
        switch exitReason {
        case .exited(let code): reasonDesc = "shell exited with code \(code)"
        case .signaled(let sig, _): reasonDesc = "shell killed by signal \(sig)"
        case .stopped: reasonDesc = "shell stopped (unexpected)"
        case .waitpidFailed(let e): reasonDesc = "waitpid failed errno=\(e)"
        }
      }
      logger.error(
        """
        lookupViaLoginShell: \(reasonDesc, privacy: .public) name='\(name, privacy: .public)' \
        shell='\(shell, privacy: .public)'. stderr tail (last 4KB):
        \(stderrTail, privacy: .public)
        """)
      throw GitError.launchFailed(
        "CLI resolver: '\(name)' via '\(shell)' \(reasonDesc). See Console.app for stderr.")
    }

    let text = String(decoding: stdoutBytes, as: UTF8.self)
    // marker 間が空 = `command -v` が空 (コマンド未インストール) → nil 返却
    if isMarkerBodyEmpty(text, begin: beginMarker, end: endMarker) {
      return nil
    }
    if let path = extractAndValidatePath(text, begin: beginMarker, end: endMarker) {
      return path
    }
    // exit=0 + marker は埋まっているが絶対 executable パスではない (shell が non-POSIX、
    // alias / function を返した 等)
    logger.error(
      """
      lookupViaLoginShell: extract failed name='\(name, privacy: .public)' \
      shell='\(shell, privacy: .public)'. Shell may not parse `-i -l -c <cmd>` or `command -v`,
      or returned a non-executable path.
      """)
    throw GitError.launchFailed(
      "CLI resolver: '\(name)' via '\(shell)' returned non-executable or non-POSIX output. "
        + "Shell may not parse `-i -l -c <cmd>` or `command -v`.")
  }

  /// `command -v` の出力が空（コマンド未インストール）かを判定する。
  private static func isMarkerBodyEmpty(_ text: String, begin: String, end: String) -> Bool {
    guard let beginRange = text.range(of: begin),
      let endRange = text.range(of: end, range: beginRange.upperBound..<text.endIndex)
    else { return false }
    let body = text[beginRange.upperBound..<endRange.lowerBound]
    return body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// fd から EOF まで読み切る（同期 read を Task で非同期化）。
  /// `waitpid` と同じ流儀で EINTR は retry する（SIGCHLD 等の到来で read が中断された
  /// だけのケースを EOF と取り違えないため）。
  private static func readAllFromFd(_ fd: Int32) async -> Data {
    await Task.detached(priority: .userInitiated) {
      var data = Data()
      var buf = [UInt8](repeating: 0, count: 4096)
      while true {
        let n = buf.withUnsafeMutableBufferPointer { read(fd, $0.baseAddress, $0.count) }
        if n < 0 {
          if errno == EINTR { continue }
          break
        }
        if n == 0 { break }
        data.append(buf, count: n)
      }
      return data
    }.value
  }

  /// marker 間から「絶対パスかつ実行可能なファイル」となる行を抽出する。
  /// `command -v` は通常 1 行を返すが、shell によっては alias / function 名を返すことが
  /// あるため、`/` 始まり + `isExecutableFile` の二重検証で弾く。
  private static func extractAndValidatePath(_ text: String, begin: String, end: String)
    -> String?
  {
    guard let beginRange = text.range(of: begin),
      let endRange = text.range(of: end, range: beginRange.upperBound..<text.endIndex)
    else { return nil }
    let body = text[beginRange.upperBound..<endRange.lowerBound]
    for line in body.split(separator: "\n") {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if let validated = validateExecutablePath(trimmed) {
        return validated
      }
    }
    return nil
  }

  /// 絶対パスでかつ実行可能ファイルである場合のみ正規化したパスを返す。
  /// `isExecutableFile` は execute bit が立った directory も true を返すため、
  /// 通常ファイルであることも併せて検証する。
  private static func validateExecutablePath(_ path: String) -> String? {
    guard path.hasPrefix("/") else { return nil }
    let fm = FileManager.default
    var isDir: ObjCBool = false
    guard fm.fileExists(atPath: path, isDirectory: &isDir), !isDir.boolValue else {
      return nil
    }
    return fm.isExecutableFile(atPath: path) ? path : nil
  }
}

// MARK: - runProcessCollectingOutput

/// 共通 helper: 既に standardOutput/standardError が Pipe で構成されている `Process`
/// を起動し、子プロセス生存中から stdout/stderr を別 thread で drain する。
///
/// terminationHandler 内で `readDataToEndOfFile()` する設計だと、出力が pipe buffer
/// (macOS は最大 ~64KB) を超えた瞬間に子が write block → exit 不能 →
/// terminationHandler 永遠に呼ばれない deadlock になる。回避のため、`process.run()`
/// 直後に `DispatchQueue.global` 上で `readDataToEndOfFile()` を回し続ける。
///
/// `DispatchGroup` で「stdout EOF / stderr EOF / process termination」3 イベント
/// 全てが揃った時点で `(stdoutData, stderrData)` を返す。launch 失敗時は throw する。
///
/// 注: `afterRun` の stdin write/close は同期実行のため、stdin を読まないコマンドに
/// この helper を流用すると stdin write 自体が詰まる可能性がある。stdin 利用は
/// `git check-ignore --stdin` のような stdin を実際に読むコマンド限定で使うこと。
func runProcessCollectingOutput(
  process: Process,
  stdoutPipe: Pipe,
  stderrPipe: Pipe,
  afterRun: () -> Void = {}
) async throws -> (stdout: Data, stderr: Data) {
  // Task cancellation 対応:
  // 親 Task（例: withThrowingTaskGroup の sibling 失敗）が cancel されたとき、
  // 子 Process を SIGTERM して fail-fast にする。`withTaskCancellationHandler` で
  // continuation を包むことで cancel ハンドラから process.terminate() を呼べる。
  // process は actor 越しの参照を避けるため `nonisolated(unsafe)` ラッパーは使わず、
  // OSAllocatedUnfairLock で Process? を保護する。
  let processLock = OSAllocatedUnfairLock<Process?>(initialState: nil)
  return try await withTaskCancellationHandler {
    try await withCheckedThrowingContinuation {
      (cont: CheckedContinuation<(stdout: Data, stderr: Data), Error>) in
      let stdoutLock = OSAllocatedUnfairLock<Data>(initialState: Data())
      let stderrLock = OSAllocatedUnfairLock<Data>(initialState: Data())
      let group = DispatchGroup()

      group.enter()
      process.terminationHandler = { _ in
        group.leave()
      }

      do {
        // run() 前に既に cancel 済みなら起動せずに即返す
        if Task.isCancelled {
          cont.resume(throwing: CancellationError())
          return
        }
        group.enter()
        group.enter()
        // run() の前に processLock に格納する。run() と格納の間に onCancel が
        // 走っても、onCancel 側は `proc.isRunning` を見るので未起動なら何もしない。
        // run() が throw した場合は catch で nil に戻す。
        processLock.withLock { $0 = process }
        do {
          try process.run()
        } catch {
          processLock.withLock { $0 = nil }
          throw error
        }
        // run() 直後にキャンセル済みなら自分で terminate する。
        // 「Task.isCancelled の事前チェック → run() 起動完了 → isRunning=true 遷移」の
        // 一連の中で onCancel が走った場合、isRunning がまだ false の window を見て
        // terminate がスキップされる可能性がある。run() 後の自前チェックで救う。
        if Task.isCancelled {
          process.terminate()
        }
        DispatchQueue.global(qos: .userInitiated).async {
          let data = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
          stdoutLock.withLock { $0 = data }
          group.leave()
        }
        DispatchQueue.global(qos: .userInitiated).async {
          let data = stderrPipe.fileHandleForReading.readDataToEndOfFile()
          stderrLock.withLock { $0 = data }
          group.leave()
        }
        afterRun()
        group.notify(queue: DispatchQueue.global()) {
          processLock.withLock { $0 = nil }
          let stdout = stdoutLock.withLock { $0 }
          let stderr = stderrLock.withLock { $0 }
          cont.resume(returning: (stdout, stderr))
        }
      } catch {
        cont.resume(throwing: GitError.launchFailed(error.localizedDescription))
      }
    }
  } onCancel: {
    // 起動済みの Process を SIGTERM で止める。terminationHandler が group.leave() を
    // 呼び、stdout/stderr drain が EOF で抜けて group.notify が cont を resume する。
    processLock.withLock { proc in
      if let proc, proc.isRunning {
        proc.terminate()
      }
    }
  }
}
