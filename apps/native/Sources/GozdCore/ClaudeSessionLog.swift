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
  // subagent を spawn した main 側 Agent tool_use の id (meta.json の toolUseId)。main は空。
  public let parentToolUseId: String
  // subagent の名前 (meta.json の name)。名前なし起動 / main は空。
  public let name: String
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
      guard let mainContent = readText(at: mainFile) else {
        // ファイルは在るが読めない (UTF-8 decode 失敗等)。空 content で found=true を返すと
        // parse 側が空セッションと誤認するため notFound に倒す。落とした事実は観察可能にする。
        StderrLog.write(tag: "ClaudeSessionLog", "main jsonl decode failed: \(mainFile.path)")
        return .notFound
      }

      var entries: [ClaudeSessionLogEntry] = [
        ClaudeSessionLogEntry(
          kind: "main", id: sessionId, label: "", agentType: "",
          path: mainFile.path, content: mainContent, parentToolUseId: "", name: "")
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
      guard let content = readText(at: file) else {
        // main と非対称に当該 subagent だけ落とす (他 subagent は見せる) が、落とした
        // 事実は silent にせず観察可能にする。
        StderrLog.write(tag: "ClaudeSessionLog", "subagent jsonl decode failed: \(file.path)")
        return nil
      }
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
        content: content,
        parentToolUseId: meta.toolUseId,
        name: meta.name)
    }
  }

  /// agent-<id>.jsonl に対応する agent-<id>.meta.json から agentType / description /
  /// toolUseId (この subagent を spawn した main 側 Agent tool_use の id) / name を読む。
  private static func readMeta(forAgentFile file: URL) -> (
    agentType: String, description: String, toolUseId: String, name: String
  ) {
    let metaURL = file.deletingPathExtension().appendingPathExtension("meta.json")
    // meta.json 不在は正常系 (古い subagent / 未生成) なので無言で空ラベルに倒す。
    guard FileManager.default.fileExists(atPath: metaURL.path) else { return ("", "", "", "") }
    // ファイルは在るのに読めない / parse 失敗は異常なので観察ログを残す。
    guard let data = try? Data(contentsOf: metaURL),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      StderrLog.write(tag: "ClaudeSessionLog", "subagent meta decode failed: \(metaURL.path)")
      return ("", "", "", "")
    }
    let agentType = (obj["agentType"] as? String) ?? ""
    let description = (obj["description"] as? String) ?? ""
    let toolUseId = (obj["toolUseId"] as? String) ?? ""
    let name = (obj["name"] as? String) ?? ""
    // subagent は必ず Agent tool で spawn されるため meta.json には toolUseId があるはず。
    // 欠落は meta スキーマ drift の兆候。main の Agent 行と紐付けできず silent に外れるため、
    // 握り潰さず観察ログを残す (meta が parse できた = この分岐に来た場合のみ判定可能)。
    if toolUseId == "" {
      StderrLog.write(tag: "ClaudeSessionLog", "subagent meta missing toolUseId: \(metaURL.path)")
    }
    return (agentType, description, toolUseId, name)
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
