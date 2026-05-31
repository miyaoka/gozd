import Foundation

// Claude Code が ~/.claude/projects/<cwd エンコード>/<session_id>.jsonl に書き出す
// セッションログ (JSONL) の解決・読み取り。
//
// cwd → ディレクトリ名のエンコード規則は Claude 側の内部仕様で将来変わりうるため
// 再構成に依存しない。session_id (UUID) は一意なので ~/.claude/projects/*/<session_id>.jsonl
// を glob 解決する。fork で別ファイルに分裂したセッションも自分の session_id を
// ファイル名に持つため、この解決で確実に 1 ファイルへ辿れる。
//
// Task ツールで起動したサブエージェントの会話は
// <projectDir>/<session_id>/subagents/agent-<agentId>.jsonl に別ファイル (isSidechain) で
// 記録される。main の projectDir を起点にこのサブディレクトリも列挙して返す。
public struct ClaudeSessionLogEntry: Sendable, Equatable {
  public let kind: String  // "main" | "subagent"
  public let id: String  // main は session_id、subagent は agent_id
  public let label: String  // subagent の meta.json description。main は空
  public let agentType: String  // subagent の meta.json agentType。main は空
  public let path: String
  public let content: String
}

public struct ClaudeSessionLogResult: Sendable, Equatable {
  public let found: Bool
  public let entries: [ClaudeSessionLogEntry]

  public static let notFound = ClaudeSessionLogResult(found: false, entries: [])
}

public enum ClaudeSessionLog {
  /// session_id から main jsonl + subagents を解決して読む。見つからなければ notFound を返す。
  public static func read(sessionId: String) -> ClaudeSessionLogResult {
    guard isSafeSessionId(sessionId) else { return .notFound }

    let fm = FileManager.default
    let projectsDir = fm.homeDirectoryForCurrentUser
      .appendingPathComponent(".claude", isDirectory: true)
      .appendingPathComponent("projects", isDirectory: true)

    let mainFileName = "\(sessionId).jsonl"
    guard
      let projectDirs = try? fm.contentsOfDirectory(
        at: projectsDir,
        includingPropertiesForKeys: [.isDirectoryKey],
        options: [.skipsHiddenFiles]
      )
    else {
      return .notFound
    }

    for projectDir in projectDirs {
      let mainFile = projectDir.appendingPathComponent(mainFileName, isDirectory: false)
      guard fm.fileExists(atPath: mainFile.path) else { continue }
      guard let mainContent = readText(at: mainFile) else { return .notFound }

      var entries: [ClaudeSessionLogEntry] = [
        ClaudeSessionLogEntry(
          kind: "main", id: sessionId, label: "", agentType: "",
          path: mainFile.path, content: mainContent)
      ]
      // subagents: <projectDir>/<sessionId>/subagents/agent-*.jsonl
      let subagentsDir = projectDir
        .appendingPathComponent(sessionId, isDirectory: true)
        .appendingPathComponent("subagents", isDirectory: true)
      entries.append(contentsOf: readSubagents(in: subagentsDir))
      return ClaudeSessionLogResult(found: true, entries: entries)
    }
    return .notFound
  }

  /// subagents ディレクトリ配下の agent-*.jsonl を agentId 昇順 (決定的) で読む。
  /// 同名 .meta.json (agentType / description) があればラベルに使う。
  private static func readSubagents(in dir: URL) -> [ClaudeSessionLogEntry] {
    let fm = FileManager.default
    guard
      let files = try? fm.contentsOfDirectory(
        at: dir, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
    else {
      return []
    }

    let jsonlFiles = files
      .filter { $0.pathExtension == "jsonl" && $0.lastPathComponent.hasPrefix("agent-") }
      .sorted { $0.lastPathComponent < $1.lastPathComponent }

    return jsonlFiles.compactMap { file -> ClaudeSessionLogEntry? in
      guard let content = readText(at: file) else { return nil }
      // "agent-<agentId>.jsonl" → "<agentId>"
      let agentId = file.deletingPathExtension().lastPathComponent
        .replacingOccurrences(of: "agent-", with: "")
      let meta = readMeta(forAgentFile: file)
      return ClaudeSessionLogEntry(
        kind: "subagent",
        id: agentId,
        label: meta.description,
        agentType: meta.agentType,
        path: file.path,
        content: content)
    }
  }

  /// agent-<id>.jsonl に対応する agent-<id>.meta.json から agentType / description を読む。
  private static func readMeta(forAgentFile file: URL) -> (agentType: String, description: String) {
    let metaURL = file.deletingPathExtension().appendingPathExtension("meta.json")
    guard let data = try? Data(contentsOf: metaURL),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      return ("", "")
    }
    let agentType = (obj["agentType"] as? String) ?? ""
    let description = (obj["description"] as? String) ?? ""
    return (agentType, description)
  }

  /// UTF-8 file を文字列で読む。読めなければ nil。
  private static func readText(at url: URL) -> String? {
    guard let data = try? Data(contentsOf: url),
      let text = String(data: data, encoding: .utf8)
    else {
      return nil
    }
    return text
  }

  /// session_id を appendingPathComponent に渡す前の入力ゲート。
  /// UUID 構成文字 ([0-9a-fA-F-]) のみ許可し、`/` や `..` 経由の path traversal を構造的に塞ぐ。
  private static func isSafeSessionId(_ sessionId: String) -> Bool {
    if sessionId.isEmpty { return false }
    return sessionId.allSatisfy { ch in
      ch.isHexDigit || ch == "-"
    }
  }
}
