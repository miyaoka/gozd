import Foundation

// branch / remote 系の RPC op。HEAD branch / upstream / default branch の解決と
// background fetch を担う。`runGitNonInteractive` を使う fetchRemotes 以外は通常の `runGit` 経路。

extension GitOps {
  /// HEAD が指す branch 名を返す (例: `main` / `feature/foo`)。
  /// porcelain v2 の `# branch.head` と同一の semantics を `git symbolic-ref --short HEAD`
  /// で取得し、SSOT を `gitStatusChange` push payload と一致させる。
  ///
  /// 挙動の場合分け:
  /// - 通常の branch (HEAD が refs/heads/<name> を指す): branch 名を exit 0 で返す
  /// - unborn branch (`git init -b main` 直後、commit 無し): symbolic-ref は branch 名
  ///   (`main`) を exit 0 で返す。porcelain v2 の `# branch.head` も同じく branch 名を返すため
  ///   SSOT が揃う
  /// - detached HEAD: symbolic-ref は exit 128 で `commandFailed` を throw する
  ///
  /// 呼び出し側で `commandFailed` を空文字列に倒すかは judgment に委ねる (`log` は倒す)。
  /// `launchFailed` / `commandNotFound` は本関数からは握り潰さず rethrow し、上位の
  /// notify.error 経路に通す (silent drop 禁止規律)。
  public static func branchHeadName(dir: String) async throws -> String {
    let stdout = try await runGit(args: ["symbolic-ref", "--short", "HEAD"], cwd: dir)
    return String(decoding: stdout, as: UTF8.self).trimmingCharacters(
      in: .whitespacesAndNewlines)
  }

  /// HEAD の upstream ref 名を返す (例: `origin/foo` / `upstream/main`)。
  /// upstream 未設定 / detached HEAD では `commandFailed` を throw する。呼び出し側で
  /// `commandFailed` を空文字列に倒すかは judgment に委ねる (`log` は倒す)。
  /// `launchFailed` / `commandNotFound` は本関数からは握り潰さず rethrow し、上位の
  /// notify.error 経路に通す (silent drop 禁止規律)。
  public static func upstreamRefName(dir: String) async throws -> String {
    let stdout = try await runGit(
      args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], cwd: dir)
    return String(decoding: stdout, as: UTF8.self).trimmingCharacters(
      in: .whitespacesAndNewlines)
  }

  /// `git symbolic-ref --short refs/remotes/origin/HEAD` 相当。`origin/main` 等を返す。
  /// origin/ の prefix は剥がして `main` のみ返す。
  public static func defaultBranchName(dir: String) async throws -> String {
    let stdout = try await runGit(
      args: ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd: dir)
    let text = String(decoding: stdout, as: UTF8.self).trimmingCharacters(
      in: .whitespacesAndNewlines)
    if text.hasPrefix("origin/") { return String(text.dropFirst("origin/".count)) }
    return text
  }

  /// HEAD が commit OID を解決できるかを返す。`git rev-parse --verify --quiet HEAD` を使い、
  /// exit 0 なら true (通常 branch / detached HEAD)、exit ≠ 0 なら false (unborn branch 等)。
  ///
  /// エラー方針 (`silent drop 禁止規律` に沿った粒度):
  /// - `commandFailed` + stderr 空: `--quiet` で unborn HEAD を silently 弾いた正常パス。silent に false
  /// - 上記以外 (`commandFailed` で stderr 非空 / `launchFailed` / `commandNotFound` /
  ///   `unexpectedOutput`): 異常系の可能性があるため `StderrLog` に 1 行残してから false に倒す。
  ///   実害は HEAD log 経路 (`runLogStdin`) や他 ref 経路で同 root cause が表面化するため
  ///   ここでは fail-soft で graph 表示を止めない方針を踏襲し、観察可能性のみ確保する。
  ///
  /// 契約: 引数列の `--quiet` が unborn HEAD で「exit ≠ 0 + stderr 空」を保証する。
  /// このフラグを除くと git は unborn でも stderr に `fatal: Needed a single revision` を
  /// 書き出し、上の where 句 (`stderr.isEmpty`) が成立しなくなって catch-all に倒れる。
  /// 結果として「正常パスである unborn」が毎 loadLog で `StderrLog` 1 行を出す noise になる。
  /// 振る舞いとしては fail-soft なので壊滅しないが、catch 分岐の意味が壊れるため必須フラグ。
  public static func headOidExists(dir: String) async -> Bool {
    do {
      _ = try await runGit(
        // `--quiet`: 上の `stderr.isEmpty` 分岐契約を成立させるため必須 (docstring 参照)。
        args: ["rev-parse", "--verify", "--quiet", "HEAD"], cwd: dir)
      return true
    } catch let GitError.commandFailed(_, stderr) where stderr.isEmpty {
      // unborn HEAD: `--quiet` で stderr 空、exit ≠ 0。正常系として silent に倒す。
      return false
    } catch {
      StderrLog.write(
        tag: "GitOps", "headOidExists: fallback to false (\(error)) dir=\(dir)")
      return false
    }
  }

  /// `git fetch --all --no-write-fetch-head` 相当。背景自動 fetch 用。
  ///
  /// - `--all`: 全 remote を fetch。upstream が `origin` 以外 (fork PR workflow で
  ///   upstream=upstream / origin=fork 等) でも UI の ahead/behind を最新化できる。
  ///   VSCode autofetch の `"all"` モード相当
  /// - `--no-write-fetch-head`: `FETCH_HEAD` を書き換えない。`FETCH_HEAD` は手動
  ///   `git pull` の起点としてユーザーが意識する短期記憶で、背景 fetch が
  ///   上書きするとユーザーの「最後に fetch した内容」感覚が壊れる
  /// - `--prune` は付けない: リモートで削除された branch がローカル refs から消えると
  ///   サイドバー表示も同期して消え、ユーザーが混乱する。明示操作に残す
  /// - `--tags` は付けない: 重く、ahead/behind 計算には不要
  ///
  /// 非対話化:
  ///
  /// - `GIT_TERMINAL_PROMPT=0`: HTTPS の credential prompt を抑止し、認証情報が
  ///   無い場合は即座に exit 128 で失敗させる (hang 防止)
  /// - `GIT_SSH_COMMAND` 末尾に ` -o BatchMode=yes`: SSH の passphrase / known_hosts
  ///   prompt を抑止。agent / key が無効なら即失敗
  ///
  /// 失敗は throw する。呼び出し側で「offline / 認証失敗等は静かに飲み込む」判断をする。
  public static func fetchRemotes(dir: String) async throws {
    _ = try await runGitNonInteractive(
      args: ["fetch", "--all", "--no-write-fetch-head"], cwd: dir)
  }
}
