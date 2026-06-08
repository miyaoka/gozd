import Foundation

// Claude Code が ~/.claude/projects/<cwd エンコード>/<session_id>.jsonl に書き出す
// セッションログ (JSONL) の解決・読み取り。
//
// 解決方式: worktree_path (PTY 起動時の cwd) から `~/.claude/projects/<encoded>/` を
// 決定的に組み立てる。encoded は cwd の `/` `.` を `-` に置換した形 (実機観察)。
// session_id だけを受け取って全 projectDir を glob walk する旧設計は廃止した:
// JSONL が SessionStart 時点では未生成な race と、cross-session の fsChange ノイズを
// 構造的に解消するため。fork で cwd を別場所に移したセッションは追えない trade-off。
//
// Task ツールで起動したサブエージェントの会話は
// <projectDir>/<session_id>/subagents/agent-<agentId>.jsonl に別ファイル (isSidechain) で
// 記録される。main の projectDir を起点にこのサブディレクトリも列挙して返す。
//
// Workflow ツールで起動したサブエージェントはさらに 1 階層深い
// <projectDir>/<session_id>/subagents/workflows/<wf_id>/agent-<agentId>.jsonl に記録される。
// これらの meta.json は agentType しか持たないため、表示名 / phase は
// <projectDir>/<session_id>/workflows/<wf_id>.json の workflowProgress から agentId を
// キーに JOIN する。
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
  // workflow agent が属する workflow run の id (wf_xxx)。非 workflow subagent / main は空。
  public let workflowRunId: String
  // workflow の表示名 (wf json の workflowName)。非 workflow subagent / main は空。
  public let workflowName: String
  // workflow agent の phase 名 (workflowProgress の phaseTitle)。非 workflow subagent / main は空。
  public let phaseTitle: String

  public init(
    kind: String, id: String, label: String, agentType: String, path: String, content: String,
    parentToolUseId: String, name: String,
    workflowRunId: String = "", workflowName: String = "", phaseTitle: String = ""
  ) {
    self.kind = kind
    self.id = id
    self.label = label
    self.agentType = agentType
    self.path = path
    self.content = content
    self.parentToolUseId = parentToolUseId
    self.name = name
    self.workflowRunId = workflowRunId
    self.workflowName = workflowName
    self.phaseTitle = phaseTitle
  }
}

public struct ClaudeSessionLogResult: Sendable, Equatable {
  public let found: Bool
  public let entries: [ClaudeSessionLogEntry]
  // renderer が fsWatch を張る specific projectDir (~/.claude/projects/<encoded>/)。
  // !found 時も同じ specific dir で、未生成なら read() 内で idempotent に mkdir した上で
  // 返す。worktreePath 空 / unsafe sessionId 等で encoded dir を組み立てられない場合に
  // 限り空文字を返す (renderer 側で watch を張らず error 化する契約)。
  public let watchDir: String

  public init(found: Bool, entries: [ClaudeSessionLogEntry], watchDir: String) {
    self.found = found
    self.entries = entries
    self.watchDir = watchDir
  }
}

public enum ClaudeSessionLog {
  /// session_id + worktree_path から specific projectDir (~/.claude/projects/<encoded>/) を
  /// 解決し、main jsonl + subagents を読み込む。
  ///
  /// JSONL は SessionStart 時点では作られず、最初の UserPromptSubmit で初めて書かれる。
  /// `worktreePath` から expected projectDir を組み立て、不在なら idempotent mkdir で
  /// 作ってから watchDir として返す。これにより renderer は SessionStart 直後でも specific
  /// projectDir を fsWatch でき、他セッションが同居する projects 親への fallback を持たない
  /// (親 watch は cross-session の fsChange ノイズで refresh が常時走り続けるため不採用)。
  ///
  /// worktreePath 空 / encoded 不能なケースは watchDir 空文字で返し、renderer 側で error
  /// として可視化する。silent fallback は持たない (CLAUDE.md「fallback せずエラーにする」)。
  public static func read(sessionId: String, worktreePath: String) -> ClaudeSessionLogResult {
    let fm = FileManager.default
    let projectsDir = fm.homeDirectoryForCurrentUser
      .appendingPathComponent(".claude", isDirectory: true)
      .appendingPathComponent("projects", isDirectory: true)

    let watchDir = resolveSpecificWatchDir(
      worktreePath: worktreePath, projectsDir: projectsDir, fm: fm)

    guard isSafeSessionId(sessionId) else {
      return ClaudeSessionLogResult(found: false, entries: [], watchDir: watchDir)
    }

    // JSONL は worktreePath 由来の specific projectDir 直下に置かれる (Claude Code の仕様)。
    // worktreePath が空 / 解決不能で encoded dir を組み立てられない場合は found=false で
    // 早期 return。元来の「全 projectDir glob で sessionId に該当する jsonl を引く」経路は
    // 廃止 (worktreePath が SSOT で、glob は cross-session ノイズの温床になるため)。
    guard !watchDir.isEmpty else {
      return ClaudeSessionLogResult(found: false, entries: [], watchDir: watchDir)
    }

    let projectDir = URL(fileURLWithPath: watchDir, isDirectory: true)
    let mainFile = projectDir.appendingPathComponent("\(sessionId).jsonl", isDirectory: false)
    guard fm.fileExists(atPath: mainFile.path) else {
      return ClaudeSessionLogResult(found: false, entries: [], watchDir: watchDir)
    }
    guard let mainContent = readText(at: mainFile) else {
      // ファイルは在るが読めない (UTF-8 decode 失敗等)。空 content で found=true を返すと
      // parse 側が空セッションと誤認するため notFound に倒す。落とした事実は観察可能にする。
      StderrLog.write(tag: "ClaudeSessionLog", "main jsonl decode failed: \(mainFile.path)")
      return ClaudeSessionLogResult(found: false, entries: [], watchDir: watchDir)
    }

    var entries: [ClaudeSessionLogEntry] = [
      ClaudeSessionLogEntry(
        kind: "main", id: sessionId, label: "", agentType: "",
        path: mainFile.path, content: mainContent, parentToolUseId: "", name: "")
    ]
    // subagents: <projectDir>/<sessionId>/subagents/agent-*.jsonl (Task ツール)
    let sessionDir = projectDir.appendingPathComponent(sessionId, isDirectory: true)
    let subagentsDir = sessionDir.appendingPathComponent("subagents", isDirectory: true)
    entries.append(contentsOf: readSubagents(in: subagentsDir))
    // workflow subagents: <subagents>/workflows/<wf_id>/agent-*.jsonl (Workflow ツール)。
    // ラベルは <sessionDir>/workflows/<wf_id>.json (兄弟) から JOIN する。
    entries.append(
      contentsOf: readWorkflowSubagents(
        in: subagentsDir.appendingPathComponent("workflows", isDirectory: true),
        metaDir: sessionDir.appendingPathComponent("workflows", isDirectory: true)))
    return ClaudeSessionLogResult(found: true, entries: entries, watchDir: watchDir)
  }

  /// worktreePath から `~/.claude/projects/<encoded>/` を組み立て、不在なら mkdir で作る。
  /// 失敗時は空文字を返す (renderer 側で「watch を張らずに error 表示」に倒す契約)。
  ///
  /// mkdir は idempotent。Claude Code 側も同じ dir に書き込むため、gozd が先に作っても
  /// 衝突しない。FSWatchRegistry は watch 対象 cwd で git CLI を spawn する経路を持つため、
  /// 不在 dir を渡すと launchFailed になる。事前 mkdir で構造的に回避する。
  ///
  /// internal 公開は test 用 (副作用境界 3 分岐 = 既存 / mkdir 成功 / mkdir 失敗 を直接
  /// 検証するため。本番経路は `read()` 内からのみ呼ばれる)。
  static func resolveSpecificWatchDir(
    worktreePath: String, projectsDir: URL, fm: FileManager
  ) -> String {
    guard let dirPath = encodedProjectDir(worktreePath: worktreePath, projectsDir: projectsDir)
    else {
      return ""
    }
    var isDir: ObjCBool = false
    if fm.fileExists(atPath: dirPath, isDirectory: &isDir), isDir.boolValue {
      return dirPath
    }
    let dirURL = URL(fileURLWithPath: dirPath, isDirectory: true)
    do {
      try fm.createDirectory(at: dirURL, withIntermediateDirectories: true)
      return dirPath
    } catch {
      StderrLog.write(
        tag: "ClaudeSessionLog",
        "mkdir failed: path=\(dirPath) error=\(error)")
      return ""
    }
  }

  /// Claude Code が `cwd` から ~/.claude/projects/<encoded>/ を組み立てる際のエンコード規則。
  /// 実機観察: `/` と `.` を `-` に置換 (例: `/Users/foo/.local/bar` →
  /// `-Users-foo--local-bar`)。Claude 側の内部仕様で将来変わりうるが、変わったら表示が
  /// 出ない不具合として顕在化するので、silent fallback で degrade させるよりも検出
  /// 可能性が高い。空文字 / absolute でないパスは nil を返す。
  ///
  /// internal 公開は test 用 (encoding 規則の境界値を直接 assert するため)。
  static func encodedProjectDir(worktreePath: String, projectsDir: URL) -> String? {
    guard !worktreePath.isEmpty, worktreePath.hasPrefix("/") else { return nil }
    var encoded = ""
    encoded.reserveCapacity(worktreePath.count)
    for ch in worktreePath {
      if ch == "/" || ch == "." {
        encoded.append("-")
      } else {
        encoded.append(ch)
      }
    }
    return projectsDir.appendingPathComponent(encoded, isDirectory: true).path
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

  /// workflowProgress の 1 agent エントリから JOIN する表示メタ。
  private struct WorkflowAgentMeta {
    let label: String
    let phaseTitle: String
    let agentType: String
  }

  /// subagents/workflows/<wf_id>/agent-*.jsonl を workflow ごと / agentId 昇順 (決定的) で読む。
  /// 表示名 / phase / agentType は metaDir/<wf_id>.json の workflowProgress から JOIN する。
  /// agent の meta.json は agentType しか持たないため、workflowProgress に無い場合のみ
  /// meta.json の agentType をフォールバックに使う。
  private static func readWorkflowSubagents(in dir: URL, metaDir: URL) -> [ClaudeSessionLogEntry] {
    let fm = FileManager.default
    // workflows ディレクトリ不在は正常系 (workflow 未使用セッション) なので無言で空配列に倒す。
    guard
      let wfDirs = try? fm.contentsOfDirectory(
        at: dir, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])
    else {
      return []
    }

    let sortedWfDirs = wfDirs
      .filter { $0.lastPathComponent.hasPrefix("wf_") }
      .sorted { $0.lastPathComponent < $1.lastPathComponent }

    var entries: [ClaudeSessionLogEntry] = []
    for wfDir in sortedWfDirs {
      let wfId = wfDir.lastPathComponent
      let (workflowName, agentMeta) = readWorkflowProgress(metaDir: metaDir, wfId: wfId)

      guard
        let files = try? fm.contentsOfDirectory(
          at: wfDir, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
      else {
        continue
      }
      let jsonlFiles = files
        .filter { $0.pathExtension == "jsonl" && $0.lastPathComponent.hasPrefix("agent-") }
        .sorted { $0.lastPathComponent < $1.lastPathComponent }

      for file in jsonlFiles {
        guard let content = readText(at: file) else {
          StderrLog.write(
            tag: "ClaudeSessionLog", "workflow subagent jsonl decode failed: \(file.path)")
          continue
        }
        let agentId = file.deletingPathExtension().lastPathComponent
          .replacingOccurrences(of: "agent-", with: "")
        let progress = agentMeta[agentId]
        // wf json は読めて workflowProgress も解析できた (agentMeta 非空) のに、この agentId
        // だけ載っていない = JOIN ミス。journal / progress の追記タイミング差等で起こりうる
        // 信頼境界外データの兆候なので silent にせず観察ログを残す (ラベル無しで agent 自体は表示)。
        if progress == nil && !agentMeta.isEmpty {
          StderrLog.write(
            tag: "ClaudeSessionLog",
            "workflow agent missing in progress: wfId=\(wfId) agentId=\(agentId)")
        }
        // agentType は workflowProgress 優先、空なら agent の meta.json をフォールバック。
        let progressAgentType = progress?.agentType ?? ""
        let agentType =
          progressAgentType.isEmpty
          ? readAgentTypeFromMeta(forAgentFile: file) : progressAgentType
        entries.append(
          ClaudeSessionLogEntry(
            kind: "subagent",
            id: agentId,
            label: progress?.label ?? "",
            agentType: agentType,
            path: file.path,
            content: content,
            parentToolUseId: "",
            name: "",
            workflowRunId: wfId,
            workflowName: workflowName,
            phaseTitle: progress?.phaseTitle ?? ""))
      }
    }
    return entries
  }

  /// metaDir/<wf_id>.json を読み、workflowName と agentId→表示メタの Map を返す。
  /// 不在 / parse 失敗時は空 (ラベル無しで agent 自体は表示できるため致命ではないが観察ログは残す)。
  private static func readWorkflowProgress(metaDir: URL, wfId: String) -> (
    workflowName: String, agentMeta: [String: WorkflowAgentMeta]
  ) {
    let metaURL = metaDir.appendingPathComponent("\(wfId).json", isDirectory: false)
    guard FileManager.default.fileExists(atPath: metaURL.path) else { return ("", [:]) }
    guard let data = try? Data(contentsOf: metaURL),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      StderrLog.write(tag: "ClaudeSessionLog", "workflow json decode failed: \(metaURL.path)")
      return ("", [:])
    }
    let workflowName = (obj["workflowName"] as? String) ?? ""
    var agentMeta: [String: WorkflowAgentMeta] = [:]
    if let progress = obj["workflowProgress"] as? [[String: Any]] {
      for e in progress where (e["type"] as? String) == "workflow_agent" {
        guard let agentId = e["agentId"] as? String, !agentId.isEmpty else { continue }
        agentMeta[agentId] = WorkflowAgentMeta(
          label: (e["label"] as? String) ?? "",
          phaseTitle: (e["phaseTitle"] as? String) ?? "",
          // agentType は null のことがある (例: synthesis / judge)。その場合は空文字に倒す。
          agentType: (e["agentType"] as? String) ?? "")
      }
    }
    return (workflowName, agentMeta)
  }

  /// agent-<id>.meta.json から agentType だけ読む (workflow agent の fallback 用)。
  /// workflow agent の meta.json は agentType しか持たず toolUseId を構造的に欠くため、
  /// toolUseId 必須チェックを持つ readMeta を流用すると正常な workflow agent で偽陽性の
  /// "subagent meta missing toolUseId" ログが量産される。agentType だけ読む経路を分けて回避する。
  /// 不在は正常系で無言、parse 失敗のみ観察ログを残す (silent drop 禁止規律)。
  private static func readAgentTypeFromMeta(forAgentFile file: URL) -> String {
    let metaURL = file.deletingPathExtension().appendingPathExtension("meta.json")
    guard FileManager.default.fileExists(atPath: metaURL.path) else { return "" }
    guard let data = try? Data(contentsOf: metaURL),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      StderrLog.write(tag: "ClaudeSessionLog", "workflow agent meta decode failed: \(metaURL.path)")
      return ""
    }
    return (obj["agentType"] as? String) ?? ""
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
