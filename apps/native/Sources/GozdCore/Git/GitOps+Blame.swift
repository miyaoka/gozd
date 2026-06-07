import Foundation

// blame と blame-anchored log (`logLine`) を扱う。前者は `git blame --porcelain` の 1 行 spawn、
// 後者は `git log -L<n>,<n>:<path>` で 1 行の変更履歴を walk する。両者とも `logFormat` /
// `parseLogRecords` SSOT (Log.swift) を共有する。`BLAME_MAX_BLOB_BYTES` の boundary check は
// `ensureBlameableSize` に閉じる。

/// blame 対象ファイルのサイズ上限。これを超えると blame は秒オーダーでブロックするため
/// 早期に reject する。閾値は GitHub の blame UI のハード上限と同等の目安。
/// `internal` にして `@testable import GozdCore` で boundary テストから直接参照できるようにする。
let BLAME_MAX_BLOB_BYTES = 2 * 1024 * 1024

extension GitOps {
  /// 単一行の blame 結果。`git blame --porcelain -L <line>,<line> [<rev>] -- <relPath>` を
  /// 1 行ぶんに絞ってヘッダ + メタ行のみを parse する。
  ///
  /// rev が空文字なら rev を渡さず working tree を blame。working tree の未コミット行は
  /// porcelain ヘッダの sha が全 0 で返るため `notCommitted` フラグに倒す。
  ///
  /// `--incremental` を使わない理由: 1 行 RPC 用途では出力は数行で、`--porcelain` の方が
  /// すべてのメタ行が必ず付随する保証があり parse 規約が簡単。
  ///
  /// 大ファイル保護: blame は出力が 1 行でも対象ファイル全体を walk するため、
  /// `pnpm-lock.yaml` 級 (数 MB) のファイルでブロックする。`git cat-file -s` で
  /// blob サイズを先に測り `BLAME_MAX_BLOB_BYTES` を超えたら `commandFailed` 互換で reject。
  public static func blameLine(dir: String, relPath: String, rev: String, line: UInt32)
    async throws -> BlameLineInfo
  {
    try validateRev(rev)
    try await ensureBlameableSize(dir: dir, rev: rev, relPath: relPath)
    var args = ["blame", "--porcelain", "-L", "\(line),\(line)"]
    if !rev.isEmpty { args.append(rev) }
    args.append("--")
    args.append(relPath)
    let stdout = try await runGit(args: args, cwd: dir)
    let text = String(decoding: stdout, as: UTF8.self)

    var hash = ""
    var sourceLine: UInt32 = line
    var author = ""
    var authorMail = ""
    var authorTime: Int64 = 0
    var summary = ""
    var headerSeen = false
    for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
      // CRLF 等の trailing whitespace で `Int64(...)` parse が失敗して
      // authorTime が 0 に倒れるのを防ぐため trim する。
      let s = String(rawLine).trimmingCharacters(in: .whitespacesAndNewlines)
      if rawLine.first == "\t" {
        // ソース行本体。--porcelain は 1 回だけ出力する。以降のメタ行はないので break。
        // trim 前の文字を見ないと先頭タブが落ちて誤判定する。
        break
      }
      if !headerSeen {
        // 最初の非タブ行はヘッダ: "<sha> <orig_line> <final_line> [<group_size>]"
        let parts = s.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        if parts.count >= 3 {
          hash = parts[0]
          if let n = UInt32(parts[1]) { sourceLine = n }
        }
        headerSeen = true
        continue
      }
      if s.hasPrefix("author ") {
        author = String(s.dropFirst("author ".count))
      } else if s.hasPrefix("author-mail ") {
        // `<email>` 形式で囲まれる。<> を剥がして mailto-friendly に。
        let raw = String(s.dropFirst("author-mail ".count))
        if raw.hasPrefix("<") && raw.hasSuffix(">") {
          authorMail = String(raw.dropFirst().dropLast())
        } else {
          authorMail = raw
        }
      } else if s.hasPrefix("author-time ") {
        if let n = Int64(s.dropFirst("author-time ".count)) { authorTime = n }
      } else if s.hasPrefix("summary ") {
        summary = String(s.dropFirst("summary ".count))
      }
    }

    if hash.isEmpty {
      throw GitError.unexpectedOutput("git blame: missing porcelain header")
    }
    let notCommitted = hash.allSatisfy { $0 == "0" }
    let shortHash = String(hash.prefix(7))
    return BlameLineInfo(
      hash: hash,
      shortHash: shortHash,
      author: author,
      authorMail: authorMail,
      authorTime: authorTime,
      summary: summary,
      sourceLine: sourceLine,
      notCommitted: notCommitted
    )
  }

  /// 単一行の変更履歴。`git log -L<line>,<line>:<relPath> --no-patch <rev>` 相当。
  ///
  /// `--no-patch` で diff 本体を抑制し、`logFormat` 定数で commit metadata のみ取り出す。
  /// parse は `parseLogRecords` SSOT を経由するため、`runLogStdin` と同じ strict 契約
  /// (8 fields 不一致 / Int64 author date 失敗 → `unexpectedOutput` throw) を共有する。
  ///
  /// path に `:` を含む場合は `-L<n>,<n>:<path>` の syntax が壊れるため reject。
  /// rev は `validateRev` で `-` 始まり等の option 注入を弾き、加えて **空文字も reject** する。
  /// 本 RPC は呼び出し側 (`useBlamePopover`) が必ず blame した commit hash を起点として
  /// 流す契約のため、rev="" で HEAD 起点 walk に倒れると「blame した commit を含まない
  /// history」が返って意味契約が壊れる。SSOT 違反を構造的に防ぐため空文字は明示 reject。
  public static func logLine(
    dir: String, relPath: String, rev: String, line: UInt32, maxCount: UInt32
  ) async throws -> [CommitInfo] {
    if rev.isEmpty {
      throw GitError.unexpectedOutput(
        "git log -L: rev must be specified (empty rev would walk HEAD and break the "
          + "blame-anchored contract)")
    }
    try validateRev(rev)
    if relPath.contains(":") {
      // git log -L の `-L<n>,<n>:<path>` は `:` を separator として使うため、
      // path に `:` を含むと正しく parse されない。仕様上の制約のため明示 reject。
      throw GitError.unexpectedOutput("git log -L: path contains ':', which is unsupported")
    }
    var args = [
      "log",
      "--format=\(GitOps.logFormat)",
      "--decorate=short",
      "--no-patch",
      "-L", "\(line),\(line):\(relPath)",
    ]
    if maxCount > 0 { args.append("--max-count=\(maxCount)") }
    args.append(rev)
    let stdout = try await runGit(args: args, cwd: dir)
    let text = String(decoding: stdout, as: UTF8.self)
    return try parseLogRecords(text)
  }
}

/// `rev` 指定時のサイズチェック helper。rev 指定時は `git cat-file -s <rev>:<relPath>`、
/// working tree (rev="") なら fs stat。
///
/// 観察可能性: silent fallback は **想定された "存在しない" 経路のみ** に限定する。
/// - working tree: file-not-found (`NSFileReadNoSuchFileError`) のみ silent 通過。
///   blame は同条件で git の「no such path」エラーに倒れて RPC error として表面化する
/// - rev 指定: `git cat-file -s` の `commandFailed`（exit 128 等、path 未解決 / 不正 rev）のみ
///   silent 通過。`launchFailed` / `commandNotFound` / `unexpectedOutput` は再 throw して
///   観察可能化する。これらは「予期しない異常」で blame に進むと UI ブロックが救えない
private func ensureBlameableSize(dir: String, rev: String, relPath: String) async throws {
  let bytes: Int
  if rev.isEmpty {
    // working tree。Path を URL で組み立てて `FileManager.attributesOfItem` で読む。
    let fileURL = URL(fileURLWithPath: dir, isDirectory: true)
      .appendingPathComponent(relPath, isDirectory: false)
    do {
      let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
      bytes = (attrs[.size] as? Int) ?? 0
    } catch let nsError as NSError {
      // file-not-found のみ「blame 側で notFound として表面化させる」silent 経路。
      // permission / I/O 異常等は throw して隠さない。
      if nsError.domain == NSCocoaErrorDomain
        && nsError.code == NSFileReadNoSuchFileError
      {
        return
      }
      throw nsError
    }
  } else {
    do {
      let stdout = try await runGit(
        args: ["cat-file", "-s", "\(rev):\(relPath)"], cwd: dir)
      let s = String(decoding: stdout, as: UTF8.self).trimmingCharacters(
        in: .whitespacesAndNewlines)
      // exit 0 で stdout が非数値 (repo 破損 / 想定外フォーマット) の場合に
      // `?? 0` で 0 化すると size gate を素通りして blame に進んでしまう。
      // 観察可能化のため throw に倒す ("fallback せずエラーにする" 規約)。
      guard let parsed = Int(s) else {
        throw GitError.unexpectedOutput("git cat-file -s returned unparseable size: \(s)")
      }
      bytes = parsed
    } catch GitError.commandFailed {
      // exit code != 0: root commit の `^` / 未追跡 path / invalid rev 等で `cat-file` が
      // 失敗するケースのみ silent 通過。blame 側でも同 rev:path が解決失敗するため
      // RPC error として一貫した経路で表面化する。
      return
    }
    // launchFailed / commandNotFound / unexpectedOutput / その他は再 throw して観察可能化する
  }
  if bytes > BLAME_MAX_BLOB_BYTES {
    throw GitError.unexpectedOutput(
      "git blame: file too large (\(bytes) bytes > \(BLAME_MAX_BLOB_BYTES))")
  }
}
