import Darwin
import Foundation
import os

// `Process` を `git` / `gh` 等の外部 CLI 起動に使うときの共通基盤。
//
// 解決すべき 2 つの問題:
//
// 1. **PATH 不足**: `.app` を Finder/Dock から起動すると launchd 経由で渡される PATH は
//    `/usr/bin:/bin:/usr/sbin:/sbin` のみ。Homebrew (`/opt/homebrew/bin`) や mise / asdf
//    配下の CLI は解決できない。`git` は `/usr/bin/git` の Apple stub に救われるが
//    `gh` は救われない。dev (`pnpm dev`) ではターミナル PATH を継承するので顕在化しない。
//
// 2. **pipe drain の deadlock**: `terminationHandler` 内で `readDataToEndOfFile()` する
//    naive 実装は出力が macOS の pipe buffer (~64KB) を超えると子プロセスが
//    write block → exit 不能 → terminationHandler 永遠に呼ばれない deadlock を起こす。
//
// `CommandResolver` で 1 を、`runProcessCollectingOutput` で 2 を解決する。

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

  /// SIGKILL / 解決失敗の事実を Console.app から追えるよう `os.Logger` で記録する。
  /// `lookupInCurrentPath` 撤去で `lookupViaLoginShell` が単一経路に格上げされ、
  /// silent timeout が起きるとユーザーには `launchFailed` としか見えないため、
  /// (a) `pw_shell` が exotic / (b) `command -v` 不解釈 / (c) rc hang を切り分け可能にする。
  private static let logger = Logger(subsystem: "dev.miyaoka.gozd", category: "command-resolver")

  private var cache: [String: String] = [:]
  private var inflight: [String: Task<String?, Never>] = [:]

  /// 指定 name の絶対パスを返す。見つからなければ nil。結果はキャッシュされる。
  public func resolve(_ name: String) async -> String? {
    if let cached = cache[name] { return cached }
    if let inflight = inflight[name] { return await inflight.value }

    let task = Task { await Self.lookup(name) }
    inflight[name] = task
    let result = await task.value
    inflight[name] = nil
    if let result {
      cache[name] = result
    }
    return result
  }

  /// キャッシュを無効化する。`runGit` / `runGh` が `launchFailed` を受けたときに
  /// 呼んで再解決のチャンスを与える。
  public func invalidate(_ name: String) {
    cache[name] = nil
  }

  private static func lookup(_ name: String) async -> String? {
    return await lookupViaLoginShell(name)
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

  /// `<shell> -i -l -c '<script>'` で絶対パスを取得。
  /// rc ファイルが余計な文字列を stdout に流すケースに備えて UUID marker で囲んで抽出する。
  /// `-i` で interactive shell を起動するため、親の stdin 継承を防ぐべく `/dev/null` を渡し、
  /// rc の hang に備えて 10 秒で SIGKILL する。
  ///
  /// 対応シェル: `-i -l -c` フラグおよび POSIX `command -v` を解釈する shell（bash / zsh /
  /// dash / fish 等）を想定。これらに該当しないログインシェル（tcsh / nushell / xonsh の
  /// 一部呼び出し方法等）の場合は本関数が nil を返す。呼び出し側はそれを受けて
  /// `runGh` / `runGit` で `launchFailed` を throw し、上位 (RPC dispatcher) で
  /// HTTP error として renderer に通知される。renderer 側で `notify.error` を表示する。
  private static func lookupViaLoginShell(_ name: String) async -> String? {
    let shell = userLoginShell()
    let token = UUID().uuidString
    let beginMarker = "GOZD_BEGIN_\(token)"
    let endMarker = "GOZD_END_\(token)"
    let script =
      "printf '%s\\n' \(beginMarker); command -v \(name); printf '%s\\n' \(endMarker)"

    let process = Process()
    process.executableURL = URL(fileURLWithPath: shell)
    process.arguments = ["-i", "-l", "-c", script]
    // 余計な ZDOTDIR 等が継承されないよう、PATH 解決には素の env を渡す。
    // gozd の PTY overlay (GozdEnvOverlay) はここに混ざらない（PTYRegistry でのみ merge）。
    process.environment = ProcessInfo.processInfo.environment
    if let devNull = FileHandle(forReadingAtPath: "/dev/null") {
      process.standardInput = devNull
    }
    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe

    let timeoutTask = Task { [process, shell, name] in
      try? await Task.sleep(nanoseconds: 10 * 1_000_000_000)
      if process.isRunning {
        let pid = process.processIdentifier
        if pid > 0 {
          _ = kill(pid, SIGKILL)
          logger.error(
            """
            lookupViaLoginShell timed out after 10s for '\(name, privacy: .public)' \
            via shell '\(shell, privacy: .public)'; sent SIGKILL. \
            shell rc may be hanging or shell may not parse `-i -l -c '<cmd>'`.
            """)
        }
      }
    }
    defer { timeoutTask.cancel() }

    let (stdoutData, stderrData): (Data, Data)
    do {
      (stdoutData, stderrData) = try await runProcessCollectingOutput(
        process: process,
        stdoutPipe: stdoutPipe,
        stderrPipe: stderrPipe
      )
    } catch {
      logger.error(
        """
        lookupViaLoginShell failed to launch shell '\(shell, privacy: .public)' \
        for '\(name, privacy: .public)': \(error.localizedDescription, privacy: .public)
        """)
      return nil
    }

    guard process.terminationStatus == 0 else {
      let stderrText = String(decoding: stderrData, as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
      logger.error(
        """
        lookupViaLoginShell exit \(process.terminationStatus) for '\(name, privacy: .public)' \
        via shell '\(shell, privacy: .public)': \(stderrText, privacy: .public)
        """)
      return nil
    }
    let text = String(decoding: stdoutData, as: UTF8.self)
    if let path = extractAndValidatePath(text, begin: beginMarker, end: endMarker) {
      return path
    }
    logger.error(
      """
      lookupViaLoginShell could not parse `command -v \(name, privacy: .public)` output \
      via shell '\(shell, privacy: .public)'. Shell may not support `-i -l -c` or \
      `command -v`, or may have returned an alias / function instead of an absolute path.
      """)
    return nil
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
