import Foundation

// git CLI を Foundation `Process` 経由で呼び出すラッパー。GitOps の各 op はここを経由する。
//
// 設計判断:
//
// 1. **`CommandResolver` 経由で `git` の絶対パスを解決**: `.app` を Finder/Dock 起動
//    すると launchd 由来の最小 PATH しか継承されないため `/usr/bin/env` の PATH 解決
//    では Homebrew / mise 版 git を選べない。`CommandResolver` がユーザーログインシェル
//    経由で `command -v git` を実行し、ターミナルで叩く git と同一バイナリを返す。
//    解決に失敗した場合は `launchFailed` を throw して呼び出し側 (notify.error) に
//    通知する。Apple stub `/usr/bin/git` への暗黙 fallback は行わない: ターミナルで
//    Homebrew git を使っているユーザーに対して `.app` だけ CLT git に倒すと、Keychain
//    ACL が binary path 単位のため credential が引き継がれず、認証プロンプトが
//    再発する。CLT only ユーザーはログインシェル経由でも `/usr/bin/git` が返るため
//    fallback 無しでも救われる。
//
// 2. **stdout / stderr は子プロセス生存中に readabilityHandler で drain する**:
//    `terminationHandler` 内で `readDataToEndOfFile()` する設計だと、出力が
//    pipe buffer (macOS は最大 ~64KB) を超えた瞬間に子が write block →
//    exit できず → terminationHandler が呼ばれない deadlock になる。
//    readabilityHandler + DispatchGroup.notify で「stdout EOF / stderr EOF /
//    process termination」が揃った時点で resume する。共通 helper は
//    `ProcessExec.swift` の `runProcessCollectingOutput` に集約。

/// `git` の絶対パスを resolve する。
///
/// - shell spawn 失敗 / hang / 起動エラー → `GitError.launchFailed` を throw（retry 対象）
/// - `command -v` が空 = git CLI 未インストール → `GitError.commandNotFound` を throw（retry 不要、即上位へ）
///
/// Apple stub `/usr/bin/git` への暗黙 fallback は行わない（モジュール先頭コメント参照）。
private func resolveGitPath() async throws -> String {
  guard let path = try await CommandResolver.shared.resolve("git") else {
    throw GitError.commandNotFound(name: "git")
  }
  return path
}

/// gozd 用 git 環境変数を組み立てる。`ProcessInfo.processInfo.environment` を snapshot し、
/// `GIT_OPTIONAL_LOCKS=0` を上書き設定する。
///
/// `GIT_OPTIONAL_LOCKS=0` は read-only な git コマンド (`status` 等) が index stat refresh
/// 用に行う **opportunistic な `index.lock` 取得を抑止**する。gozd は FSEvents 駆動で
/// バックグラウンドに `git status` 等を頻繁に叩くため、この設定が無いとユーザーが foreground
/// で叩いた `git commit` / `git add` と lock 競合し、ユーザー側が exit 128
/// (`Unable to create '.../index.lock': File exists`) で即死する。
/// git 自身がこのシナリオ（バックグラウンドツール並走）のために提供している env で、
/// VS Code / GitHub Desktop 等の主要 GUI クライアントも同じ設定を入れている。
private func gozdGitEnv() -> [String: String] {
  var env = ProcessInfo.processInfo.environment
  env["GIT_OPTIONAL_LOCKS"] = "0"
  return env
}

/// 非対話 git 起動用の env を組み立てる。pure function (テスト可能)。
///
/// - `GIT_TERMINAL_PROMPT=0`: HTTPS credential prompt を抑止
/// - `GIT_SSH_COMMAND` には ` -o BatchMode=yes` を末尾に追記する。完全上書きすると
///   ユーザーが ProxyCommand 等を env に設定しているケースを壊すため、既存値を保つ。
///   ただし空文字列 / 空白のみは「未設定」と等価扱いにする。そのまま追記すると
///   先頭の ssh 実行ファイル名が消えて " -o BatchMode=yes" になり ssh が起動できない
///
/// `base` には `gozdGitEnv()` 等の親 env を渡す。新規 dict を返し副作用は持たない。
public func buildNonInteractiveEnv(base: [String: String]) -> [String: String] {
  var env = base
  env["GIT_TERMINAL_PROMPT"] = "0"
  let trimmed = env["GIT_SSH_COMMAND"]?.trimmingCharacters(in: .whitespaces) ?? ""
  let existingSsh = trimmed.isEmpty ? "ssh" : trimmed
  env["GIT_SSH_COMMAND"] = "\(existingSsh) -o BatchMode=yes"
  return env
}

/// stdin にデータを渡して git を起動する。`runGit` と同じ戻り値契約。
/// `launchFailed` を検知した場合、CommandResolver のキャッシュが stale な可能性が
/// あるため 1 回だけ invalidate + 再 resolve して retry する。
///
/// `treatNonZeroExitAsSuccess`:
/// - `false` (default, **厳格**): exit code ≠ 0 は常に `commandFailed` で throw する。
///   `git log --stdin` / `git check-ref-format --stdin` 等、exit code が普通の成否シグナルである
///   コマンド用。`git log` 子プロセスが SIGPIPE / SIGTERM で「exit ≠ 0 + stderr 空」終了したケースが
///   silent に空 stdout として通過するのを防ぐ。
/// - `true` (**緩和**): `git check-ignore` 専用 opt-in。check-ignore は無視パスがあれば exit 0、
///   無ければ exit 1 を返す仕様で、**exit code がちょうど 1 かつ stderr が空** のときだけ
///   「結果なし」として stdout を返す。exit code 2 以上 / signal 終了 (SIGPIPE 等で exit 128+N)
///   は stderr が空でも throw して、シグナル経由の異常終了を success に倒さない。
///   check-ignore 以外で使ってはならない (silent drop 禁止規律違反になる)。
func runGitWithStdin(
  args: [String], cwd: String, stdin: Data, treatNonZeroExitAsSuccess: Bool = false
) async throws -> Data {
  do {
    return try await runGitWithStdinOnce(
      gitPath: try await resolveGitPath(), args: args, cwd: cwd, stdin: stdin,
      treatNonZeroExitAsSuccess: treatNonZeroExitAsSuccess)
  } catch GitError.launchFailed {
    await CommandResolver.shared.invalidate("git")
    return try await runGitWithStdinOnce(
      gitPath: try await resolveGitPath(), args: args, cwd: cwd, stdin: stdin,
      treatNonZeroExitAsSuccess: treatNonZeroExitAsSuccess)
  }
}

private func runGitWithStdinOnce(
  gitPath: String, args: [String], cwd: String, stdin: Data, treatNonZeroExitAsSuccess: Bool
)
  async throws -> Data
{
  let process = Process()
  process.executableURL = URL(fileURLWithPath: gitPath)
  process.arguments = args
  process.currentDirectoryURL = URL(fileURLWithPath: cwd)
  // 明示的に env snapshot を渡す。Foundation Process は environment が nil のとき
  // 内部で `ProcessInfo.processInfo.environment` を遅延読みするが、その経路は
  // `getenv`/`environ` の thread-unsafety が並列 spawn 時に EFAULT (Code=14) を
  // 引く要因になり得る。spawn 前に snapshot を取って渡せば内部 lazy read を回避できる。
  process.environment = gozdGitEnv()

  let stdinPipe = Pipe()
  let stdoutPipe = Pipe()
  let stderrPipe = Pipe()
  process.standardInput = stdinPipe
  process.standardOutput = stdoutPipe
  process.standardError = stderrPipe

  let (stdoutData, stderrData) = try await runProcessCollectingOutput(
    process: process,
    stdoutPipe: stdoutPipe,
    stderrPipe: stderrPipe,
    afterRun: {
      // stdin を書き込んで EOF を送る。書き込み中の例外は git 終了で拾うので try? で握る。
      try? stdinPipe.fileHandleForWriting.write(contentsOf: stdin)
      try? stdinPipe.fileHandleForWriting.close()
    }
  )

  // exit code 0 → 常に success。
  // exit code 1 → caller が `treatNonZeroExitAsSuccess=true` を選んでいる場合のみ、
  // かつ stderr が空のときに「結果なし」として stdout を返す (check-ignore opt-in)。
  // check-ignore の契約は「無視 path 無し = exit 1」のみ。exit 2 以上 (`fatal: ...`) や
  // signal 終了 (SIGPIPE → exit 141 等) は stderr が空でも throw する。
  // それ以外はすべて throw。
  if process.terminationStatus == 0 {
    return stdoutData
  }
  if treatNonZeroExitAsSuccess && process.terminationStatus == 1 && stderrData.isEmpty {
    return stdoutData
  }
  throw GitError.commandFailed(
    exitCode: process.terminationStatus,
    stderr: String(decoding: stderrData, as: UTF8.self))
}

func runGit(args: [String], cwd: String) async throws -> Data {
  do {
    return try await runGitOnce(gitPath: try await resolveGitPath(), args: args, cwd: cwd)
  } catch GitError.launchFailed {
    await CommandResolver.shared.invalidate("git")
    return try await runGitOnce(gitPath: try await resolveGitPath(), args: args, cwd: cwd)
  }
}

/// 認証 prompt を完全に塞いで git を起動する。HTTPS / SSH のどちらでも背景 fetch が
/// passphrase / username 入力で hang するのを防ぐため、`fetch` 等のリモート操作専用。
func runGitNonInteractive(args: [String], cwd: String) async throws -> Data {
  do {
    return try await runGitNonInteractiveOnce(
      gitPath: try await resolveGitPath(), args: args, cwd: cwd)
  } catch GitError.launchFailed {
    await CommandResolver.shared.invalidate("git")
    return try await runGitNonInteractiveOnce(
      gitPath: try await resolveGitPath(), args: args, cwd: cwd)
  }
}

private func runGitNonInteractiveOnce(gitPath: String, args: [String], cwd: String) async throws
  -> Data
{
  let process = Process()
  process.executableURL = URL(fileURLWithPath: gitPath)
  process.arguments = args
  process.currentDirectoryURL = URL(fileURLWithPath: cwd)
  process.environment = buildNonInteractiveEnv(base: gozdGitEnv())

  let stdoutPipe = Pipe()
  let stderrPipe = Pipe()
  process.standardOutput = stdoutPipe
  process.standardError = stderrPipe

  let (stdoutData, stderrData) = try await runProcessCollectingOutput(
    process: process,
    stdoutPipe: stdoutPipe,
    stderrPipe: stderrPipe
  )

  if process.terminationStatus == 0 {
    return stdoutData
  }
  throw GitError.commandFailed(
    exitCode: process.terminationStatus,
    stderr: String(decoding: stderrData, as: UTF8.self))
}

private func runGitOnce(gitPath: String, args: [String], cwd: String) async throws -> Data {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: gitPath)
  process.arguments = args
  process.currentDirectoryURL = URL(fileURLWithPath: cwd)
  process.environment = gozdGitEnv()

  let stdoutPipe = Pipe()
  let stderrPipe = Pipe()
  process.standardOutput = stdoutPipe
  process.standardError = stderrPipe

  let (stdoutData, stderrData) = try await runProcessCollectingOutput(
    process: process,
    stdoutPipe: stdoutPipe,
    stderrPipe: stderrPipe
  )

  if process.terminationStatus == 0 {
    return stdoutData
  }
  throw GitError.commandFailed(
    exitCode: process.terminationStatus,
    stderr: String(decoding: stderrData, as: UTF8.self))
}

/// `git diff --no-index` 用の variant。exit 0 (差分なし) / 1 (差分あり) を共に
/// 成功扱いし stdout を返す。>1 は通常エラー扱いで throw する。
/// `git diff` は差分があると exit 1 を返す仕様で、これを runGit の標準ハンドリングに
/// 通すと throw されて stdout を失うため専用 path を用意する。
func runGitDiffNoIndex(args: [String], cwd: String) async throws -> Data {
  do {
    return try await runGitDiffNoIndexOnce(
      gitPath: try await resolveGitPath(), args: args, cwd: cwd)
  } catch GitError.launchFailed {
    await CommandResolver.shared.invalidate("git")
    return try await runGitDiffNoIndexOnce(
      gitPath: try await resolveGitPath(), args: args, cwd: cwd)
  }
}

private func runGitDiffNoIndexOnce(gitPath: String, args: [String], cwd: String) async throws
  -> Data
{
  let process = Process()
  process.executableURL = URL(fileURLWithPath: gitPath)
  process.arguments = args
  process.currentDirectoryURL = URL(fileURLWithPath: cwd)
  process.environment = gozdGitEnv()

  let stdoutPipe = Pipe()
  let stderrPipe = Pipe()
  process.standardOutput = stdoutPipe
  process.standardError = stderrPipe

  let (stdoutData, stderrData) = try await runProcessCollectingOutput(
    process: process,
    stdoutPipe: stdoutPipe,
    stderrPipe: stderrPipe
  )

  if process.terminationStatus <= 1 {
    return stdoutData
  }
  throw GitError.commandFailed(
    exitCode: process.terminationStatus,
    stderr: String(decoding: stderrData, as: UTF8.self))
}
