import Foundation

// `gh` CLI を Process 経由で叩いて GitHub の PR / Issue / viewer を取得する。
//
// 設計判断:
//
// 1. **gh CLI 必須**。未インストール / 未認証時は launch 失敗または exit code != 0 を
//    nil 相当として扱い、呼び出し側が UI 非表示にできるようにする。
//
// 2. **GraphQL 経由**。`gh pr list --json author` / `gh issue list --json author` は
//    `{login, id, is_bot, name}` のみで `avatarUrl` を返さない。アバター画像 URL を
//    取得するには `gh api graphql` で `author { avatarUrl }` を直接問い合わせる
//    必要がある。bot アカウント（renovate 等）も正しく解決するため
//    `https://github.com/{login}.png` 構築は採らない。
//
// 3. **戻り値は素の Swift struct**。proto への詰め替えは RPC 境界で行う。
public enum GitHubOps {
  // GitHub の avatar 画像サイズ（px）。PR/Issue picker 行の表示サイズに合わせる。
  private static let avatarSize = 64

  // `owner { login }` は廃止 (fork 判定にはローカルで parse した owner を使う)。
  // `assignees` / `reviewRequests` は PR picker の filter 機能 (PrPickerDialog) で参照する
  // ため一覧 query にそのまま含める。inner page は元のまま 100 を維持。
  private static let prQuery = """
    query($owner: String!, $repo: String!, $limit: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequests(first: $limit, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes {
            number
            title
            url
            state
            isDraft
            headRefName
            baseRefName
            author { login avatarUrl(size: \(avatarSize)) }
            updatedAt
            headRepository { owner { login } }
            assignees(first: 100) { nodes { login } }
            reviewRequests(first: 100) { nodes { requestedReviewer { ... on User { login } } } }
          }
        }
      }
    }
    """

  private static let issueQuery = """
    query($owner: String!, $repo: String!, $limit: Int!) {
      repository(owner: $owner, name: $repo) {
        issues(first: $limit, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes {
            number
            title
            url
            state
            author { login avatarUrl(size: \(avatarSize)) }
            updatedAt
            labels(first: 100) { nodes { name } }
            assignees(first: 100) { nodes { login } }
          }
        }
      }
    }
    """

  public static func prList(dir: String) async throws -> PrListResult {
    guard let (owner, repo) = try await repoOwnerName(dir: dir) else {
      return .failure(GhError(kind: .repoNotFound, detail: "no remote.origin.url"))
    }
    let data: Data
    do {
      data = try await runGhCategorized(
        args: graphqlArgs(owner: owner, repo: repo, query: prQuery), cwd: dir)
    } catch let err as GhError {
      return .failure(err)
    }
    guard
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let repository = (root["data"] as? [String: Any])?["repository"] as? [String: Any],
      let nodes = (repository["pullRequests"] as? [String: Any])?["nodes"] as? [[String: Any]]
    else {
      return .failure(GhError(kind: .other, detail: "unexpected response shape"))
    }

    // fork PR を除外（自リポジトリの owner と一致するもののみ）。
    // worktree 作成側 (registerPrCommand.ts) が `origin/<headRef>` を startPoint に
    // 使うため、fork からの PR は ref 解決に失敗する。
    // owner は repoOwnerName で local に得たものを SSOT として使う。
    let repoOwner = owner

    let infos: [PullRequestInfo] = nodes.compactMap { item -> PullRequestInfo? in
      let headOwner =
        ((item["headRepository"] as? [String: Any])?["owner"] as? [String: Any])?["login"]
        as? String
      if headOwner != repoOwner { return nil }
      let authorDict = item["author"] as? [String: Any]
      let author = authorDict?["login"] as? String ?? ""
      let avatar = authorDict?["avatarUrl"] as? String ?? ""
      let assignees =
        ((item["assignees"] as? [String: Any])?["nodes"] as? [[String: Any]])?
        .compactMap { $0["login"] as? String } ?? []
      let reviewers =
        ((item["reviewRequests"] as? [String: Any])?["nodes"] as? [[String: Any]])?
        .compactMap { ($0["requestedReviewer"] as? [String: Any])?["login"] as? String } ?? []
      // ISO8601 (Z) → "yyyy-MM-ddTHH:mm:ssZ" のまま渡す。proto は string 型。
      return PullRequestInfo(
        number: UInt32(item["number"] as? Int ?? 0),
        title: item["title"] as? String ?? "",
        url: item["url"] as? String ?? "",
        state: item["state"] as? String ?? "",
        author: author,
        headRef: item["headRefName"] as? String ?? "",
        baseRef: item["baseRefName"] as? String ?? "",
        isDraft: item["isDraft"] as? Bool ?? false,
        assignees: assignees,
        reviewers: reviewers,
        updatedAt: item["updatedAt"] as? String ?? "",
        authorAvatarUrl: avatar
      )
    }
    return .success(infos)
  }

  public static func issueList(dir: String) async throws -> IssueListResult {
    guard let (owner, repo) = try await repoOwnerName(dir: dir) else {
      return .failure(GhError(kind: .repoNotFound, detail: "no remote.origin.url"))
    }
    let data: Data
    do {
      data = try await runGhCategorized(
        args: graphqlArgs(owner: owner, repo: repo, query: issueQuery), cwd: dir)
    } catch let err as GhError {
      return .failure(err)
    }
    guard
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let nodes = (((root["data"] as? [String: Any])?["repository"] as? [String: Any])?[
        "issues"] as? [String: Any])?["nodes"] as? [[String: Any]]
    else {
      return .failure(GhError(kind: .other, detail: "unexpected response shape"))
    }

    let infos: [IssueInfo] = nodes.map { item in
      let authorDict = item["author"] as? [String: Any]
      let author = authorDict?["login"] as? String ?? ""
      let avatar = authorDict?["avatarUrl"] as? String ?? ""
      let labels =
        ((item["labels"] as? [String: Any])?["nodes"] as? [[String: Any]])?
        .compactMap { $0["name"] as? String } ?? []
      let assignees =
        ((item["assignees"] as? [String: Any])?["nodes"] as? [[String: Any]])?
        .compactMap { $0["login"] as? String } ?? []
      return IssueInfo(
        number: UInt32(item["number"] as? Int ?? 0),
        title: item["title"] as? String ?? "",
        url: item["url"] as? String ?? "",
        state: item["state"] as? String ?? "",
        author: author,
        labels: labels,
        assignees: assignees,
        updatedAt: item["updatedAt"] as? String ?? "",
        authorAvatarUrl: avatar
      )
    }
    return .success(infos)
  }

  // `-F` は型推論で number/bool を渡しうるため、string にしたい owner/repo/query は
  // `-f` を使う。limit のみ Int として渡したいので `-F` で渡す。
  private static func graphqlArgs(owner: String, repo: String, query: String) -> [String] {
    return [
      "api", "graphql",
      "-f", "owner=\(owner)",
      "-f", "repo=\(repo)",
      "-F", "limit=100",
      "-f", "query=\(query)",
    ]
  }

  /// `git config --get remote.origin.url` をパースして GitHub の owner/repo を取得する。
  ///
  /// 以前は `gh repo view --json owner,name` を使っていたが、これは picker / PR 一覧の
  /// 取得ごとに GitHub REST API を 1 回消費していた。owner/repo は remote URL から
  /// 同等に得られ、外部通信なしで完結する。
  ///
  /// 対応する URL 形式 (host は `github.com` のみ):
  /// - `https://github.com/<owner>/<repo>(.git)?`
  /// - `git@github.com:<owner>/<repo>(.git)?`
  /// - `ssh://git@github.com/<owner>/<repo>(.git)?`
  ///
  /// GitLab / Bitbucket / GitHub Enterprise 等の non-github.com remote は nil を返す
  /// (`gh` のデフォルト host は github.com なので、別ホスト remote で `gh api graphql` を
  /// 実行すると認証失敗が混入し、観察可能性を汚す)。
  private static func repoOwnerName(dir: String) async throws -> (owner: String, repo: String)? {
    let data: Data
    do {
      data = try await runGit(args: ["config", "--get", "remote.origin.url"], cwd: dir)
    } catch GitError.commandFailed {
      // remote.origin 未設定（新規 repo / fork なし）。PR 一覧自体が成立しない。
      return nil
    }
    let url = String(decoding: data, as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return parseGitHubOwnerRepo(url: url)
  }

  /// `gh api user --jq .login` で認証中ユーザーの login を返す。
  public static func viewer(dir: String) async throws -> ViewerResult {
    let data: Data
    do {
      data = try await runGhCategorized(args: ["api", "user", "--jq", ".login"], cwd: dir)
    } catch let err as GhError {
      return .failure(err)
    }
    let text = String(decoding: data, as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty {
      return .failure(GhError(kind: .unauthenticated, detail: "empty login"))
    }
    return .success(text)
  }

  /// remote URL から `(owner, repo)` を抽出する。host は `github.com` のみ受理し、
  /// それ以外は nil を返す。`.git` 拡張子は剥がす。
  static func parseGitHubOwnerRepo(url: String) -> (owner: String, repo: String)? {
    let host: Substring
    var path: String
    if let range = url.range(of: "://") {
      // https://host/owner/repo, ssh://user@host/owner/repo
      let afterScheme = url[range.upperBound...]
      guard let slash = afterScheme.firstIndex(of: "/") else { return nil }
      var authority = afterScheme[..<slash]
      if let at = authority.lastIndex(of: "@") {
        authority = authority[authority.index(after: at)...]
      }
      // port 番号があれば剥がす (host:port)
      if let colon = authority.firstIndex(of: ":") {
        authority = authority[..<colon]
      }
      host = authority
      path = String(afterScheme[afterScheme.index(after: slash)...])
    } else if let colon = url.firstIndex(of: ":") {
      // scp 形式: git@host:owner/repo
      var authority = url[..<colon]
      if let at = authority.lastIndex(of: "@") {
        authority = authority[authority.index(after: at)...]
      }
      host = authority
      path = String(url[url.index(after: colon)...])
    } else {
      return nil
    }
    if host != "github.com" { return nil }
    if path.hasSuffix(".git") { path = String(path.dropLast(4)) }
    let parts = path.split(separator: "/", omittingEmptySubsequences: false)
    guard parts.count == 2 else { return nil }
    let owner = String(parts[0])
    let repo = String(parts[1])
    if owner.isEmpty || repo.isEmpty { return nil }
    return (owner, repo)
  }

  /// `runGh` の `commandFailed`（gh は走ったが non-zero exit）を stderr 内容で 4 種類に
  /// 分類して `GhError` として throw する。`launchFailed`（gh CLI 解決失敗 / 起動失敗）は
  /// そのまま rethrow し、上位 (RPC dispatcher) で HTTP error として renderer に流す。
  /// 全失敗を nil 一律化していた旧実装では、UI 側で rate limit 枯渇に気づけなかった。
  private static func runGhCategorized(args: [String], cwd: String) async throws -> Data {
    do {
      return try await runGh(args: args, cwd: cwd)
    } catch let GitError.commandFailed(_, stderr) {
      throw GhError(kind: classifyGhStderr(stderr), detail: truncateDetail(stderr))
    }
  }
}

/// 結果型エイリアス。Swift Result の Error 制約を満たすため GhError は Error に準拠。
public typealias PrListResult = Result<[PullRequestInfo], GhError>
public typealias IssueListResult = Result<[IssueInfo], GhError>
public typealias ViewerResult = Result<String, GhError>

public struct GhError: Error, Sendable, Equatable {
  public enum Kind: Sendable, Equatable {
    case rateLimit, unauthenticated, repoNotFound, network, other
  }
  public let kind: Kind
  public let detail: String
  public init(kind: Kind, detail: String) {
    self.kind = kind
    self.detail = detail
  }
}

/// gh の stderr を 4 種類に分類する。マッチパターンは GitHub CLI の実出力に基づく。
/// 順序が重要: rate limit メッセージにも "API" 等の汎用語が含まれるため、
/// 特異度の高いパターンから順に評価する。
public func classifyGhStderr(_ stderr: String) -> GhError.Kind {
  let s = stderr.lowercased()
  if s.contains("rate limit") || s.contains("api rate limit") || s.contains("secondary rate") {
    return .rateLimit
  }
  if s.contains("authentication") || s.contains("not authenticated")
    || s.contains("could not authenticate") || s.contains("bad credentials")
    || s.contains("unauthorized")
  {
    return .unauthenticated
  }
  if s.contains("not found") || s.contains("could not resolve to a repository")
    || s.contains("repository not found")
  {
    return .repoNotFound
  }
  if s.contains("could not resolve host") || s.contains("network is unreachable")
    || s.contains("connection refused") || s.contains("timeout") || s.contains("dial tcp")
  {
    return .network
  }
  return .other
}

func truncateDetail(_ s: String, maxBytes: Int = 512) -> String {
  let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmed.utf8.count <= maxBytes { return trimmed }
  // utf8 byte 境界で安全に切る
  var end = trimmed.startIndex
  var bytes = 0
  while end < trimmed.endIndex {
    let next = trimmed.index(after: end)
    let chunk = trimmed[end..<next].utf8.count
    if bytes + chunk > maxBytes { break }
    bytes += chunk
    end = next
  }
  return String(trimmed[..<end])
}

public struct PullRequestInfo: Sendable, Equatable {
  public let number: UInt32
  public let title: String
  public let url: String
  public let state: String
  public let author: String
  public let headRef: String
  public let baseRef: String
  public let isDraft: Bool
  public let assignees: [String]
  public let reviewers: [String]
  public let updatedAt: String
  public let authorAvatarUrl: String
}

public struct IssueInfo: Sendable, Equatable {
  public let number: UInt32
  public let title: String
  public let url: String
  public let state: String
  public let author: String
  public let labels: [String]
  public let assignees: [String]
  public let updatedAt: String
  public let authorAvatarUrl: String
}

// `gh` の絶対パスは `CommandResolver` で解決する。`.app` を Finder/Dock から起動すると
// launchd 由来の最小 PATH しか継承されないため `/usr/bin/env gh` では `gh` を解決
// できない。`CommandResolver` がユーザーログインシェル経由で `command -v gh` を実行
// して絶対パスを取得し、結果はキャッシュされる。見つからない場合は `launchFailed` を
// throw する。上位の `prList` / `issueList` / `viewer` は `runGhCategorized` で包んで
// おり、`commandFailed`（未認証 / rate limit / repo not found 等）を 4 種類の `GhError`
// に分類して上位に返す。`launchFailed` はそのまま rethrow → `RpcDispatcher` の handler
// から HTTP error として renderer に流れ、`notify.error` で表示される。
//
// `launchFailed` を検知した場合、キャッシュが stale な可能性があるため 1 回だけ
// invalidate + 再 resolve して retry する。
//
// 出力収集は `runProcessCollectingOutput` (ProcessExec.swift) に寄せる。
// `terminationHandler` 内で一括 drain する旧実装は `gh pr list --json --limit 100` の
// 出力が pipe buffer (~64KB) を超えると deadlock する。
private func runGh(args: [String], cwd: String) async throws -> Data {
  do {
    return try await runGhOnce(ghPath: try await resolveGhPath(), args: args, cwd: cwd)
  } catch GitError.launchFailed {
    await CommandResolver.shared.invalidate("gh")
    return try await runGhOnce(ghPath: try await resolveGhPath(), args: args, cwd: cwd)
  }
}

/// `gh` の絶対パスを resolve する。
///
/// - shell spawn 失敗 / hang / 起動エラー → `GitError.launchFailed` を throw（retry 対象）
/// - `command -v` が空 = gh CLI 未インストール → `GitError.commandNotFound` を throw（retry 不要、即上位へ）
///
/// `resolveGitPath` と同じシグネチャに揃え、解決経路と spawn 経路を呼び出し側で分離する
/// （リトライ時の invalidate + 再 resolve が同じ層で完結する）。
private func resolveGhPath() async throws -> String {
  guard let path = try await CommandResolver.shared.resolve("gh") else {
    throw GitError.commandNotFound(name: "gh")
  }
  return path
}

private func runGhOnce(ghPath: String, args: [String], cwd: String) async throws -> Data {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: ghPath)
  process.arguments = args
  process.currentDirectoryURL = URL(fileURLWithPath: cwd)
  process.environment = ProcessInfo.processInfo.environment
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
