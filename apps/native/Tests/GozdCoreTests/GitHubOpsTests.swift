import Testing

@testable import GozdCore

@Suite("classifyGhStderr")
struct ClassifyGhStderrTests {
  @Test("rate limit メッセージは rateLimit に分類")
  func rateLimit() {
    #expect(classifyGhStderr("API rate limit exceeded") == .rateLimit)
    #expect(classifyGhStderr("rate limit reached") == .rateLimit)
    #expect(classifyGhStderr("secondary rate limit triggered") == .rateLimit)
  }

  @Test("認証エラーは unauthenticated に分類")
  func unauthenticated() {
    #expect(classifyGhStderr("authentication required") == .unauthenticated)
    #expect(classifyGhStderr("not authenticated") == .unauthenticated)
    #expect(classifyGhStderr("could not authenticate to GitHub") == .unauthenticated)
    #expect(classifyGhStderr("bad credentials") == .unauthenticated)
    #expect(classifyGhStderr("HTTP 401: Unauthorized") == .unauthenticated)
  }

  @Test("repo 不在 / アクセス権なしは repoNotFound に分類")
  func repoNotFound() {
    #expect(classifyGhStderr("Not Found (HTTP 404)") == .repoNotFound)
    #expect(
      classifyGhStderr("Could not resolve to a Repository with the name 'foo/bar'")
        == .repoNotFound)
    #expect(classifyGhStderr("repository not found") == .repoNotFound)
  }

  @Test("network / DNS / 接続失敗は network に分類")
  func network() {
    #expect(classifyGhStderr("could not resolve host: api.github.com") == .network)
    #expect(classifyGhStderr("network is unreachable") == .network)
    #expect(classifyGhStderr("connection refused") == .network)
    #expect(classifyGhStderr("timeout exceeded") == .network)
    #expect(classifyGhStderr("dial tcp: lookup error") == .network)
  }

  @Test("いずれにも該当しない gh エラーは other に分類")
  func other() {
    #expect(classifyGhStderr("") == .other)
    #expect(classifyGhStderr("some unexpected gh error") == .other)
    #expect(classifyGhStderr("Resource not accessible by integration") == .other)
  }

  @Test("rate limit と other キーワードが両立する場合は rateLimit を優先")
  func rateLimitPriority() {
    // GitHub 実出力: `HTTP 403: API rate limit exceeded for user ID ...`
    #expect(classifyGhStderr("HTTP 403: API rate limit exceeded") == .rateLimit)
  }

  @Test("Could not resolve to a Repository は repoNotFound (network パターンの host resolve と区別)")
  func resolveAmbiguity() {
    // "could not resolve" は network 系の `could not resolve host` と重複しうるが、
    // unauthenticated チェックの後・network チェックの前 (repoNotFound 段) でマッチする。
    // network は `could not resolve host` の完全一致を要求するため誤分類しない。
    #expect(
      classifyGhStderr("Could not resolve to a Repository with the name 'x/y'")
        == .repoNotFound)
  }

  @Test("大文字小文字を区別しない")
  func caseInsensitive() {
    #expect(classifyGhStderr("API RATE LIMIT EXCEEDED") == .rateLimit)
    #expect(classifyGhStderr("Not Found") == .repoNotFound)
  }
}

@Suite("parseGitHubOwnerRepo")
struct ParseGitHubOwnerRepoTests {
  @Test("https URL から owner/repo を抽出")
  func httpsBasic() {
    let r = GitHubOps.parseGitHubOwnerRepo(url: "https://github.com/miyaoka/gozd")
    #expect(r?.owner == "miyaoka")
    #expect(r?.repo == "gozd")
  }

  @Test("https URL の `.git` 拡張子を剥がす")
  func httpsWithGit() {
    let r = GitHubOps.parseGitHubOwnerRepo(url: "https://github.com/miyaoka/gozd.git")
    #expect(r?.owner == "miyaoka")
    #expect(r?.repo == "gozd")
  }

  @Test("scp 形式 git@github.com:owner/repo")
  func scpFormat() {
    let r = GitHubOps.parseGitHubOwnerRepo(url: "git@github.com:miyaoka/gozd.git")
    #expect(r?.owner == "miyaoka")
    #expect(r?.repo == "gozd")
  }

  @Test("ssh:// URL")
  func sshUrl() {
    let r = GitHubOps.parseGitHubOwnerRepo(url: "ssh://git@github.com/miyaoka/gozd.git")
    #expect(r?.owner == "miyaoka")
    #expect(r?.repo == "gozd")
  }

  @Test("https URL に port 番号があっても host 判定が壊れない")
  func httpsWithPort() {
    let r = GitHubOps.parseGitHubOwnerRepo(url: "https://github.com:443/miyaoka/gozd")
    #expect(r?.owner == "miyaoka")
    #expect(r?.repo == "gozd")
  }

  @Test("non-github.com host は nil (GitLab / Bitbucket / Enterprise)")
  func nonGitHubHost() {
    #expect(GitHubOps.parseGitHubOwnerRepo(url: "https://gitlab.com/foo/bar") == nil)
    #expect(GitHubOps.parseGitHubOwnerRepo(url: "git@bitbucket.org:foo/bar.git") == nil)
    #expect(GitHubOps.parseGitHubOwnerRepo(url: "https://github.example.com/foo/bar") == nil)
  }

  @Test("空 owner / 空 repo は nil")
  func emptyParts() {
    #expect(GitHubOps.parseGitHubOwnerRepo(url: "https://github.com//repo") == nil)
    #expect(GitHubOps.parseGitHubOwnerRepo(url: "https://github.com/owner/") == nil)
    #expect(GitHubOps.parseGitHubOwnerRepo(url: "https://github.com/") == nil)
  }

  @Test("path component が 2 件以外なら nil (深い path で誤マッチさせない)")
  func unexpectedPathDepth() {
    // owner/repo/extra 形式は最後 2 component を採るのではなく nil で拒否する。
    #expect(GitHubOps.parseGitHubOwnerRepo(url: "https://github.com/owner/repo/extra") == nil)
    #expect(GitHubOps.parseGitHubOwnerRepo(url: "https://github.com/single") == nil)
  }

  @Test("scheme / `:` どちらもない入力は nil")
  func unrecognizedFormat() {
    #expect(GitHubOps.parseGitHubOwnerRepo(url: "owner/repo") == nil)
    #expect(GitHubOps.parseGitHubOwnerRepo(url: "") == nil)
  }
}

@Suite("truncateDetail")
struct TruncateDetailTests {
  @Test("maxBytes 以下の入力はそのまま (trim あり)")
  func underLimit() {
    #expect(truncateDetail("hello") == "hello")
    #expect(truncateDetail("  hello  ") == "hello")
  }

  @Test("maxBytes を超える ASCII 入力は byte 境界で切り詰める")
  func overLimitAscii() {
    let input = String(repeating: "a", count: 1000)
    let result = truncateDetail(input, maxBytes: 100)
    #expect(result.utf8.count == 100)
    #expect(result == String(repeating: "a", count: 100))
  }

  @Test("multi-byte 文字を byte 境界の途中で切らない")
  func multiByteBoundary() {
    // "あ" = 3 bytes (UTF-8). 4 文字で 12 bytes。
    let input = String(repeating: "あ", count: 10)  // 30 bytes
    let result = truncateDetail(input, maxBytes: 10)
    // 3 文字 = 9 bytes で収まる (4 文字目を入れると 12 bytes で超過)
    #expect(result.utf8.count <= 10)
    #expect(result == "あああ")
  }

  @Test("空文字 / 空白のみは空文字を返す")
  func emptyOrWhitespace() {
    #expect(truncateDetail("") == "")
    #expect(truncateDetail("   \n\t  ") == "")
  }
}
