import Foundation

// status / check-ignore 系の RPC op。`git status --porcelain=v1 / v2` と `git check-ignore`
// の生 stdout は entry 数 / オプションに左右されるため、parser を本ファイル内に置いて
// 「生 git output → 構造化データ」の写像を 1 か所に閉じる。

extension GitOps {
  public struct StatusFull: Equatable, Sendable {
    public let statuses: [String: String]
    public let head: String
    /// `git status --porcelain=v2 --branch` の `# branch.head` の値。HEAD が指す
    /// ブランチ名（例: `main`）。detached HEAD の場合は空文字。
    /// `git branch -m` は OID を変えないため、rename の検知はこの値の変化で行う。
    public let branchHead: String
    public let hasUpstream: Bool
    public let ahead: UInt32
    public let behind: UInt32
    /// 変更ファイルの最終更新時刻 (Unix 秒)。`statuses` の各パスを stat した最大値。
    /// 差分なし / 全 path で stat 失敗のときは 0。削除済みパスは stat 失敗で自動除外。
    /// FSWatchRegistry の dedup 用 Equatable には mtime も含める (synthesized) — 既存差分
    /// ファイルの再保存でも UI 側の date 列を更新するため。同一秒内の連続保存は mtime が
    /// 秒粒度で丸められて同値になるので、自然に push 頻度が秒に絞られる。
    public let latestMtime: Int64
  }

  /// `git status --porcelain=v1 -z --untracked-files=all` 相当。
  /// `--untracked-files=all` は untracked ディレクトリ配下のファイルも個別に列挙させる
  /// ため必須（外すと git が `dir/` のように親ディレクトリ 1 エントリに畳む）。
  public static func gitStatus(dir: String) async throws -> [String: String] {
    let stdout = try await runGit(
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd: dir)
    return parsePorcelainV1(stdout)
  }

  /// status + HEAD + upstream + ahead/behind を 1 セットで取得する。
  /// `gitStatusChange` push event の payload を構築するために使う。
  ///
  /// `git status --porcelain=v2 --branch -z --untracked-files=all` の `# branch.oid` /
  /// `# branch.upstream` / `# branch.ab` 行を読む。porcelain v2 の整形が一発で済むので
  /// 外部呼び出しを 1 回で済ませられる。
  /// `--untracked-files=all` は untracked ディレクトリ配下のファイルも個別に列挙させる
  /// ため必須（外すと git が `dir/` のように親ディレクトリ 1 エントリに畳む）。
  public static func gitStatusFull(dir: String) async throws -> StatusFull {
    let stdout = try await runGit(
      args: ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], cwd: dir)
    let parsed = parsePorcelainV2WithBranch(stdout)
    let latestMtime = latestMtimeOf(dir: dir, relPaths: Array(parsed.statuses.keys))
    return StatusFull(
      statuses: parsed.statuses, head: parsed.head, branchHead: parsed.branchHead,
      hasUpstream: parsed.hasUpstream, ahead: parsed.ahead, behind: parsed.behind,
      latestMtime: latestMtime)
  }

  /// 与えられた相対パス群のうち gitignore で無視されているものを Set で返す。
  /// - dir 配下が git 管理されていない / git が無い場合は空 Set を返す（throw しない）。
  /// - 入力空なら git を起動せず即時空 Set を返す。
  ///
  /// `git check-ignore --stdin -z` を使い、stdin に NUL 区切りでパスを流す。
  /// 出力も NUL 区切りで「無視されたパス」だけが返る。1 fork で全件まとめて判定できる。
  public static func checkIgnore(dir: String, relPaths: [String]) async -> Set<String> {
    if relPaths.isEmpty { return [] }
    let stdinBytes = relPaths
      .map { $0.data(using: .utf8) ?? Data() }
      .reduce(Data()) { acc, next in acc + next + Data([0x00]) }
    do {
      // check-ignore は無視パスがあれば exit 0、無ければ exit 1 を返す仕様。
      // exit 1 で stderr が空なら「無視されたパス無し」として stdout を受け取るため
      // `treatNonZeroExitAsSuccess: true` で opt-in する (このフラグは check-ignore 専用)。
      let stdout = try await runGitWithStdin(
        args: ["check-ignore", "--stdin", "-z"], cwd: dir, stdin: stdinBytes,
        treatNonZeroExitAsSuccess: true)
      return parseNulSeparatedPaths(stdout)
    } catch {
      // not a git repo / no .gitignore 等は exit code != 0。無視されたパス無しとして扱う。
      return []
    }
  }
}

// MARK: - parsers

/// `git check-ignore --stdin -z` の NUL 区切り出力をパスの Set に変換する。
private func parseNulSeparatedPaths(_ data: Data) -> Set<String> {
  var result: Set<String> = []
  var start = data.startIndex
  while start < data.endIndex {
    guard let nul = data[start...].firstIndex(of: 0x00) else { break }
    let segment = data[start..<nul]
    if !segment.isEmpty {
      result.insert(String(decoding: segment, as: UTF8.self))
    }
    start = data.index(after: nul)
  }
  return result
}

/// `git status --porcelain=v2 --branch -z` の出力を parse して StatusFull を返す。
///
/// 出力形式（NUL 区切り）:
/// - `# branch.oid <sha>` — HEAD ハッシュ。`(initial)` ならまだコミットがない
/// - `# branch.head <name>` — branch 名
/// - `# branch.upstream <name>` — upstream（あれば）
/// - `# branch.ab +<ahead> -<behind>` — ahead/behind（upstream あれば）
/// - 続いて各ファイルエントリ（`1 XY ...` / `2 XY ...` / `u ...` / `? path`）
///
/// 各エントリは XY を抽出して path にマップする。porcelain v1 と XY の形式は同じ。
/// `2`（rename）は古い path を後続の NUL 区切りで読み飛ばす。
private func parsePorcelainV2WithBranch(_ data: Data) -> GitOps.StatusFull {
  var statuses: [String: String] = [:]
  var head = ""
  var branchHead = ""
  var hasUpstream = false
  var ahead: UInt32 = 0
  var behind: UInt32 = 0

  var index = data.startIndex
  while index < data.endIndex {
    guard let nul = data[index...].firstIndex(of: 0x00) else { break }
    let entry = data[index..<nul]
    index = data.index(after: nul)
    if entry.isEmpty { continue }

    let line = String(decoding: entry, as: UTF8.self)
    if line.hasPrefix("# branch.oid ") {
      let oid = String(line.dropFirst("# branch.oid ".count))
      head = oid == "(initial)" ? "" : oid
    } else if line.hasPrefix("# branch.upstream ") {
      hasUpstream = true
    } else if line.hasPrefix("# branch.ab ") {
      // 形式: "+<ahead> -<behind>"
      let rest = line.dropFirst("# branch.ab ".count)
      let parts = rest.split(separator: " ")
      for part in parts {
        if part.hasPrefix("+") {
          ahead = UInt32(part.dropFirst()) ?? 0
        } else if part.hasPrefix("-") {
          behind = UInt32(part.dropFirst()) ?? 0
        }
      }
    } else if line.hasPrefix("# branch.head ") {
      // HEAD が指す branch 名。`git branch -m` は OID を変えないため、
      // rename を status 経路で検知する SSOT としてこの値を保持する。
      // detached HEAD の場合は `(detached)` が返るので空文字に正規化。
      let name = String(line.dropFirst("# branch.head ".count))
      branchHead = name == "(detached)" ? "" : name
    } else if line.hasPrefix("# ") {
      // 上記以外の `# ` 行（将来追加される porcelain v2 ヘッダ）は意図的に silent drop。
      // UI 要件が立った時点でここに分岐を足す。
      continue
    } else if line.hasPrefix("1 ") {
      // "1 XY <sub> <mH> <mI> <mW> <hH> <hI> <path>"
      let fields = line.split(
        separator: " ", maxSplits: 8, omittingEmptySubsequences: false)
      if fields.count >= 9 {
        let xy = String(fields[1])
        let path = String(fields[8])
        statuses[path] = xy
      }
    } else if line.hasPrefix("2 ") {
      // rename/copy: "2 XY <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>"
      // 続いて NUL 区切りで <orig_path>。
      let fields = line.split(
        separator: " ", maxSplits: 9, omittingEmptySubsequences: false)
      if fields.count >= 10 {
        let xy = String(fields[1])
        let path = String(fields[9])
        statuses[path] = xy
      }
      // orig_path を読み飛ばす
      if let origNul = data[index...].firstIndex(of: 0x00) {
        index = data.index(after: origNul)
      }
    } else if line.hasPrefix("u ") {
      // unmerged: "u XY <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"
      let fields = line.split(
        separator: " ", maxSplits: 10, omittingEmptySubsequences: false)
      if fields.count >= 11 {
        let xy = String(fields[1])
        let path = String(fields[10])
        statuses[path] = xy
      }
    } else if line.hasPrefix("? ") {
      // untracked
      let path = String(line.dropFirst(2))
      statuses[path] = "??"
    } else if line.hasPrefix("! ") {
      // ignored — 通常 --porcelain では出ないが、無視
      continue
    }
  }

  return GitOps.StatusFull(
    statuses: statuses, head: head, branchHead: branchHead,
    hasUpstream: hasUpstream, ahead: ahead, behind: behind,
    latestMtime: 0)
}

/// `relPaths` を `dir` 基準で stat し、modification time の最大値 (Unix 秒) を返す。
/// 全 path で stat 失敗 / 入力空のとき 0。削除済みパス (` D` / `D ` / `DD`) は stat 失敗で
/// 自然に除外されるため呼び出し側で事前 filter する必要はない。
private func latestMtimeOf(dir: String, relPaths: [String]) -> Int64 {
  if relPaths.isEmpty { return 0 }
  let fm = FileManager.default
  let base = URL(fileURLWithPath: dir)
  var maxTs: Int64 = 0
  for rel in relPaths {
    let full = base.appendingPathComponent(rel).path
    guard let attrs = try? fm.attributesOfItem(atPath: full),
      let mtime = attrs[.modificationDate] as? Date
    else { continue }
    let ts = Int64(mtime.timeIntervalSince1970)
    if ts > maxTs { maxTs = ts }
  }
  return maxTs
}

/// `git status --porcelain=v1 -z` の出力をパースする。
///
/// 形式:
/// - 通常エントリ: `XY SP path NUL`
/// - rename / copy: `XY SP newpath NUL oldpath NUL`（`X` または `Y` が `R` / `C`）
private func parsePorcelainV1(_ data: Data) -> [String: String] {
  var result: [String: String] = [:]
  var index = data.startIndex

  while index < data.endIndex {
    guard let nul = data[index...].firstIndex(of: 0x00) else { break }
    let entry = data[index..<nul]
    index = data.index(after: nul)

    // 最小サイズ: "XY <SP> <1 char path>" = 4 bytes
    guard entry.count >= 4 else { continue }
    let xyBytes = entry.prefix(2)
    let xy = String(decoding: xyBytes, as: UTF8.self)
    let path = String(decoding: entry.dropFirst(3), as: UTF8.self)
    result[path] = xy

    // rename / copy エントリの場合は old path を 1 つ余分に NUL 区切りで読み飛ばす。
    let firstChar = xyBytes.first
    let secondChar = xyBytes.dropFirst().first
    let isRenameOrCopy =
      firstChar == UInt8(ascii: "R") || firstChar == UInt8(ascii: "C")
      || secondChar == UInt8(ascii: "R") || secondChar == UInt8(ascii: "C")
    if isRenameOrCopy, let oldNul = data[index...].firstIndex(of: 0x00) {
      index = data.index(after: oldNul)
    }
  }

  return result
}
