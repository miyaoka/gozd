import Foundation
import GozdProto

// `gh` CLI 経由の GitHub API op の RPC handler。`GitHubOps.*` への薄いラッパー +
// `GhError.Kind` → proto enum の写像。Result 型 (Swift `Result<T, GhError>`) を proto の
// `ok` flag + `errorKind` / `errorDetail` 構造に flatten する。

extension RpcDispatcher {
  func handleGitPrList(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitPrListRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_GitPrListResponse()
    switch try await GitHubOps.prList(dir: req.dir) {
    case .success(let prs):
      resp.ok = true
      resp.prs = prs.map { p in
        var pb = Gozd_V1_GitPullRequest()
        pb.number = p.number
        pb.title = p.title
        pb.url = p.url
        pb.state = p.state
        pb.author = p.author
        pb.headRef = p.headRef
        pb.baseRef = p.baseRef
        pb.isDraft = p.isDraft
        pb.assignees = p.assignees
        pb.reviewers = p.reviewers
        pb.updatedAt = p.updatedAt
        pb.authorAvatarURL = p.authorAvatarUrl
        pb.baseRefOid = p.baseRefOid
        return pb
      }
    case .failure(let err):
      resp.ok = false
      resp.errorKind = mapGhErrorKind(err.kind)
      resp.errorDetail = err.detail
    }
    return try resp.jsonUTF8Data()
  }

  func handleGitIssueList(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitIssueListRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_GitIssueListResponse()
    switch try await GitHubOps.issueList(dir: req.dir) {
    case .success(let issues):
      resp.ok = true
      resp.issues = issues.map { i in
        var pb = Gozd_V1_GitIssue()
        pb.number = i.number
        pb.title = i.title
        pb.url = i.url
        pb.state = i.state
        pb.author = i.author
        pb.labels = i.labels
        pb.assignees = i.assignees
        pb.updatedAt = i.updatedAt
        pb.authorAvatarURL = i.authorAvatarUrl
        return pb
      }
    case .failure(let err):
      resp.ok = false
      resp.errorKind = mapGhErrorKind(err.kind)
      resp.errorDetail = err.detail
    }
    return try resp.jsonUTF8Data()
  }

  func handleGitViewer(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitViewerRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_GitViewerResponse()
    switch try await GitHubOps.viewer(dir: req.dir) {
    case .success(let login):
      resp.ok = true
      resp.login = login
    case .failure(let err):
      resp.ok = false
      resp.errorKind = mapGhErrorKind(err.kind)
      resp.errorDetail = err.detail
    }
    return try resp.jsonUTF8Data()
  }
}

/// `GhError.Kind` を proto enum にマップする。proto 側は 0=OK / 1-5=各種失敗。
/// 3 ハンドラ間で共有するため file-private で 1 か所に閉じる。
fileprivate func mapGhErrorKind(_ kind: GhError.Kind) -> Gozd_V1_GhErrorKind {
  switch kind {
  case .rateLimit: return .rateLimit
  case .unauthenticated: return .unauthenticated
  case .repoNotFound: return .repoNotFound
  case .network: return .network
  case .other: return .other
  }
}
