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

  private static let prQuery = """
    query($owner: String!, $repo: String!, $limit: Int!) {
      repository(owner: $owner, name: $repo) {
        owner { login }
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

  public static func prList(dir: String) async throws -> [PullRequestInfo]? {
    guard let (owner, repo) = try await repoOwnerName(dir: dir) else { return nil }
    guard
      let data = try await runGhOrNilOnCommandFailure(
        args: graphqlArgs(owner: owner, repo: repo, query: prQuery), cwd: dir)
    else { return nil }
    guard
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let repository = (root["data"] as? [String: Any])?["repository"] as? [String: Any],
      let nodes = (repository["pullRequests"] as? [String: Any])?["nodes"] as? [[String: Any]]
    else { return nil }

    // fork PR を除外（自リポジトリの owner と一致するもののみ）。
    // worktree 作成側 (registerPrCommand.ts) が `origin/<headRef>` を startPoint に
    // 使うため、fork からの PR は ref 解決に失敗する。
    let repoOwner = (repository["owner"] as? [String: Any])?["login"] as? String

    return nodes.compactMap { item -> PullRequestInfo? in
      if let repoOwner = repoOwner {
        let headOwner =
          ((item["headRepository"] as? [String: Any])?["owner"] as? [String: Any])?["login"]
          as? String
        if headOwner != repoOwner { return nil }
      }
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
  }

  public static func issueList(dir: String) async throws -> [IssueInfo]? {
    guard let (owner, repo) = try await repoOwnerName(dir: dir) else { return nil }
    guard
      let data = try await runGhOrNilOnCommandFailure(
        args: graphqlArgs(owner: owner, repo: repo, query: issueQuery), cwd: dir)
    else { return nil }
    guard
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let nodes = (((root["data"] as? [String: Any])?["repository"] as? [String: Any])?[
        "issues"] as? [String: Any])?["nodes"] as? [[String: Any]]
    else { return nil }

    return nodes.map { item in
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

  private static func repoOwnerName(dir: String) async throws -> (owner: String, repo: String)? {
    guard
      let data = try await runGhOrNilOnCommandFailure(
        args: ["repo", "view", "--json", "owner,name", "--jq", ".owner.login + \"/\" + .name"],
        cwd: dir)
    else { return nil }
    let text = String(decoding: data, as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let parts = text.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false)
    guard parts.count == 2 else { return nil }
    let owner = String(parts[0])
    let repo = String(parts[1])
    if owner.isEmpty || repo.isEmpty { return nil }
    return (owner, repo)
  }

  /// `gh api user --jq .login` で認証中ユーザーの login を返す。未認証なら nil。
  public static func viewer(dir: String) async throws -> String? {
    guard
      let data = try await runGhOrNilOnCommandFailure(
        args: ["api", "user", "--jq", ".login"], cwd: dir)
    else { return nil }
    let text = String(decoding: data, as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : text
  }

  /// `runGh` の `commandFailed`（gh は走ったが non-zero exit: 未認証、repo not found 等）
  /// を nil に変換するヘルパー。`launchFailed`（gh CLI 解決失敗 / 起動失敗）は rethrow し、
  /// 上位 (RPC dispatcher) で HTTP error として renderer に流す。
  /// `try?` を直接使うと両者を区別できず、`gh` 未解決でも UI 上「PR 0 件」に化けるため、
  /// `commandFailed` のみを silent 化する。
  private static func runGhOrNilOnCommandFailure(args: [String], cwd: String) async throws -> Data?
  {
    do {
      return try await runGh(args: args, cwd: cwd)
    } catch GitError.commandFailed {
      return nil
    }
  }
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
// throw する。上位の `prList` / `issueList` / `viewer` は `runGhOrNilOnCommandFailure`
// で包んでおり、`commandFailed`（未認証 / repo not found 等）のみ nil 化し
// `launchFailed` はそのまま rethrow → `RpcDispatcher` の handler から HTTP error として
// renderer に流れ、`notify.error` で表示される。
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
