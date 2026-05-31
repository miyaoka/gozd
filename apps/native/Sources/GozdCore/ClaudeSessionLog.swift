import Foundation

// Claude Code が ~/.claude/projects/<cwd エンコード>/<session_id>.jsonl に書き出す
// セッションログ (JSONL) の解決・読み取り。
//
// cwd → ディレクトリ名のエンコード規則は Claude 側の内部仕様で将来変わりうるため
// 再構成に依存しない。session_id (UUID) は一意なので ~/.claude/projects/*/<session_id>.jsonl
// を glob 解決する。fork で別ファイルに分裂したセッションも自分の session_id を
// ファイル名に持つため、この解決で確実に 1 ファイルへ辿れる。
public struct ClaudeSessionLogResult: Sendable, Equatable {
  public let found: Bool
  public let path: String
  public let content: String

  public static let notFound = ClaudeSessionLogResult(found: false, path: "", content: "")
}

public enum ClaudeSessionLog {
  /// session_id から jsonl を解決して読む。見つからなければ notFound を返す。
  public static func read(sessionId: String) -> ClaudeSessionLogResult {
    guard isSafeSessionId(sessionId) else { return .notFound }

    let projectsDir = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".claude", isDirectory: true)
      .appendingPathComponent("projects", isDirectory: true)

    let fileName = "\(sessionId).jsonl"
    let fm = FileManager.default
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
      let candidate = projectDir.appendingPathComponent(fileName, isDirectory: false)
      if fm.fileExists(atPath: candidate.path) {
        guard let data = try? Data(contentsOf: candidate),
          let text = String(data: data, encoding: .utf8)
        else {
          // ファイルは在るが読めない (UTF-8 decode 失敗等) → 見つからなかった扱いにせず
          // 空 content で found=true を返すと parse 側が「空セッション」と誤認するため、
          // notFound に倒して観察可能性は呼び出し元の stderr ログに委ねる。
          return .notFound
        }
        return ClaudeSessionLogResult(found: true, path: candidate.path, content: text)
      }
    }
    return .notFound
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
