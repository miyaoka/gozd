import Foundation

// ref store の内容ダイジェスト。FSWatchRegistry が「ref store が動いた」path 候補を検知した
// とき、実際に local (refs/heads) / remote-tracking (refs/remotes) のどちらが動いたかを内容で
// 判定するために使う。
//
// 背景: branchChange / remoteRefsChange を「どのファイルが変わったか」で分類すると ref backend
// の物理 layout に結合する。reftable backend (Git 2.51+、3.0 で default 化) は local / remote /
// HEAD を 1 つのバイナリテーブル群 `reftable/` に同居させるため、commit でも共有テーブルが
// 書き換わり、ファイル名から「remote が動いたか」を判別できない。path だけで remoteRefsChange を
// 立てると、commit のたびに renderer が `gh pr list` (GitHub API) を撃ち rate limit を累積発火
// させる。`git for-each-ref` は ref backend を git が吸収するので、内容ダイジェスト比較なら
// files / reftable 両 backend で「実際に何が動いたか」を正しく判定できる。

extension GitOps {
  public struct RefDigest: Equatable, Sendable {
    /// `refs/heads/*` の `(oid, refname)` 一覧を畳んだ文字列。local branch の作成 / 削除 /
    /// rename / commit による OID 進行で変化する。
    public let heads: String
    /// `refs/remotes/*` の `(oid, refname)` 一覧を畳んだ文字列。push / fetch による
    /// remote-tracking ref 更新で変化する。commit では変化しない。
    public let remotes: String
  }

  /// local branch (refs/heads) と remote-tracking (refs/remotes) の現在の `(oid, refname)`
  /// 一覧を、それぞれ 1 つの文字列に畳んで返す。`git for-each-ref` の出力は refname 昇順で
  /// 決定的なので、文字列そのものをダイジェストとして前回値と等値比較できる。
  ///
  /// `refs/heads` / `refs/remotes` は worktree 間で共有 (common git dir) なので、どの worktree
  /// の dir から実行しても同じ結果になる。
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
      remotes: remotes.joined(separator: "\n"))
  }
}
