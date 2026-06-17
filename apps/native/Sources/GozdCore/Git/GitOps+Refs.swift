import Foundation

// ref store の内容ダイジェスト。FSWatchRegistry が「ref store が動いた」path 候補を検知した
// とき、実際に local (refs/heads) / remote-tracking (refs/remotes) / current HEAD のどれが
// 動いたかを内容で判定するために使う。
//
// 背景: branchChange / remoteRefsChange / worktreeChange を「どのファイルが変わったか」で
// 分類すると ref backend の物理 layout に結合する。reftable backend (Git 2.51+、3.0 で default
// 化) は local / remote / HEAD を 1 つのバイナリテーブル群 `reftable/` に同居させ、`.git/HEAD`
// は `ref: refs/heads/.invalid` の凍結スタブで branch 切替でも動かない。ファイル名から「remote
// が動いたか」「branch が切り替わったか」を判別できない。`git for-each-ref` / `git symbolic-ref`
// は ref backend を git が吸収するので、内容ダイジェスト比較なら files / reftable 両 backend で
// 「実際に何が動いたか」を正しく判定できる (path 白名簿の物理 layout 結合を断つ)。

extension GitOps {
  public struct RefDigest: Equatable, Sendable {
    /// `refs/heads/*` の `(oid, refname)` 一覧を畳んだ文字列。local branch の作成 / 削除 /
    /// rename / commit による OID 進行で変化する。
    public let heads: String
    /// `refs/remotes/*` の `(oid, refname)` 一覧を畳んだ文字列。push / fetch による
    /// remote-tracking ref 更新で変化する。commit では変化しない。
    public let remotes: String
    /// 現在チェックアウト中の HEAD。attached なら symbolic-ref 先 (`refs/heads/<branch>`)、
    /// detached なら `detached:<oid>`。**branch 切替で変化し、branch 上の commit では変化しない**
    /// (commit は heads の OID を進めるだけで symbolic-ref 先は不変)。これが worktreeChange
    /// (= サイドバーの branch label を司る worktree list refetch) のトリガー。reftable では
    /// `.git/HEAD` スタブが動かないため、branch 切替を捕捉する唯一の backend 非依存 signal。
    public let head: String
  }

  /// local branch (refs/heads) / remote-tracking (refs/remotes) / current HEAD の現在値を
  /// それぞれ 1 つの文字列に畳んで返す。`git for-each-ref` の出力は refname 昇順で決定的なので、
  /// 文字列そのものをダイジェストとして前回値と等値比較できる。
  ///
  /// `refs/heads` / `refs/remotes` は worktree 間で共有 (common git dir) だが、HEAD は worktree
  /// ごとに固有 (どの branch を指すか)。この digest は commonGitDir 単位に 1 つ保持され、primary
  /// watcher (= main worktree) の dir で読むため、head は main worktree の現在 branch を表す。
  /// secondary worktree の branch 切替は `.git/worktrees/<name>/` 配下の変化として root watcher が
  /// worktreeChange に分類するため、この head digest には乗せない。
  public static func refDigest(dir: String) async throws -> RefDigest {
    let stdout = try await runGit(
      args: ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/remotes"],
      cwd: dir)
    let text = String(decoding: stdout, as: UTF8.self)
    var heads = [Substring]()
    var remotes = [Substring]()
    for line in text.split(separator: "\n") {
      guard let spaceIdx = line.firstIndex(of: " ") else { continue }
      let refname = line[line.index(after: spaceIdx)...]
      if refname.hasPrefix("refs/heads/") {
        heads.append(line)
      } else if refname.hasPrefix("refs/remotes/") {
        remotes.append(line)
      }
    }
    return RefDigest(
      heads: heads.joined(separator: "\n"),
      remotes: remotes.joined(separator: "\n"),
      head: try await currentHead(dir: dir))
  }

  /// 現在チェックアウト中の HEAD を返す。attached HEAD は `git symbolic-ref --quiet HEAD` の
  /// 出力 (`refs/heads/<branch>`)、detached HEAD は `detached:` + `git rev-parse HEAD` の OID。
  /// `symbolic-ref --quiet` は detached のとき exit 1 を返すので、それを検知して rev-parse に
  /// 倒す。exit 1 以外 (例: 非 git dir の 128) は本物のエラーとして throw を伝播させる。
  static func currentHead(dir: String) async throws -> String {
    do {
      let out = try await runGit(args: ["symbolic-ref", "--quiet", "HEAD"], cwd: dir)
      return String(decoding: out, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    } catch GitError.commandFailed(let exitCode, _) where exitCode == 1 {
      let out = try await runGit(args: ["rev-parse", "HEAD"], cwd: dir)
      return "detached:"
        + String(decoding: out, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }
  }
}
