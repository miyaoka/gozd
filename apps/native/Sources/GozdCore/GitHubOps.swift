import Foundation

// `gh` CLI を Process 経由で叩いて GitHub の PR / Issue / viewer を取得する。
//
// 設計判断:
//
// 1. **gh CLI 必須**。未インストール / 未認証時は launch 失敗または exit code != 0 を
//    nil 相当として扱い、呼び出し側が UI 非表示にできるようにする。
//
// 2. **JSON 出力 (`--json`)**。gh が安定 schema で吐くフィールドのみ取り出す。
//
// 3. **戻り値は素の Swift struct**。proto への詰め替えは RPC 境界で行う。
public enum GitHubOps {
  public static func prList(dir: String) async -> [PullRequestInfo]? {
    let fields = "number,title,url,state,author,headRefName,baseRefName,isDraft,assignees,reviewRequests,updatedAt"
    guard let data = try? await runGh(args: ["pr", "list", "--json", fields, "--limit", "100"], cwd: dir)
    else { return nil }
    guard let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
      return nil
    }
    return arr.map { item in
      let authorDict = item["author"] as? [String: Any]
      let author = authorDict?["login"] as? String ?? ""
      let avatar = authorDict?["avatarUrl"] as? String ?? ""
      let assignees =
        (item["assignees"] as? [[String: Any]])?.compactMap { $0["login"] as? String } ?? []
      let reviewers =
        (item["reviewRequests"] as? [[String: Any]])?.compactMap { $0["login"] as? String } ?? []
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

  public static func issueList(dir: String) async -> [IssueInfo]? {
    let fields = "number,title,url,state,author,labels,assignees,updatedAt"
    guard let data = try? await runGh(args: ["issue", "list", "--json", fields, "--limit", "100"], cwd: dir)
    else { return nil }
    guard let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
      return nil
    }
    return arr.map { item in
      let authorDict = item["author"] as? [String: Any]
      let author = authorDict?["login"] as? String ?? ""
      let avatar = authorDict?["avatarUrl"] as? String ?? ""
      let labels = (item["labels"] as? [[String: Any]])?.compactMap { $0["name"] as? String } ?? []
      let assignees =
        (item["assignees"] as? [[String: Any]])?.compactMap { $0["login"] as? String } ?? []
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

  /// `gh api user --jq .login` で認証中ユーザーの login を返す。未認証なら nil。
  public static func viewer(dir: String) async -> String? {
    guard let data = try? await runGh(args: ["api", "user", "--jq", ".login"], cwd: dir) else {
      return nil
    }
    let text = String(decoding: data, as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : text
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
// して絶対パスを取得し、結果はキャッシュされる。見つからない場合は launchFailed を
// throw して上位（`prList` / `issueList` / `viewer`）が `try?` で nil 化する。
//
// `launchFailed` を検知した場合、キャッシュが stale な可能性があるため 1 回だけ
// invalidate + 再 resolve して retry する。
//
// 出力収集は `runProcessCollectingOutput` (ProcessExec.swift) に寄せる。
// `terminationHandler` 内で一括 drain する旧実装は `gh pr list --json --limit 100` の
// 出力が pipe buffer (~64KB) を超えると deadlock する。
private func runGh(args: [String], cwd: String) async throws -> Data {
  do {
    return try await runGhOnce(args: args, cwd: cwd)
  } catch GitError.launchFailed {
    await CommandResolver.shared.invalidate("gh")
    return try await runGhOnce(args: args, cwd: cwd)
  }
}

private func runGhOnce(args: [String], cwd: String) async throws -> Data {
  guard let ghPath = await CommandResolver.shared.resolve("gh") else {
    throw GitError.launchFailed("gh CLI not found in PATH or user login shell")
  }
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
