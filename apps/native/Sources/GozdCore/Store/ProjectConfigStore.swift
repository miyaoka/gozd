import Foundation
import GozdProto
import SwiftProtobuf

// プロジェクト固有の設定永続化（`~/.config/gozd/projects/<projectKey>/config.json`）。
// projectKey の算出は `ProjectKey` を参照。
//
// 将来バージョンが増やしたフィールドが入った JSON を旧 binary で読んでも
// parse error にならないよう `ignoreUnknownFields = true` を渡す。
public final class ProjectConfigStore {
  private let configDir: String

  public init(configDir: String) {
    self.configDir = configDir
  }

  public func load(dir: String) throws -> Gozd_V1_ProjectConfig {
    let path = filePath(for: dir)
    if !FileManager.default.fileExists(atPath: path) {
      return Gozd_V1_ProjectConfig()
    }
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    let json = String(decoding: data, as: UTF8.self)
    var options = JSONDecodingOptions()
    options.ignoreUnknownFields = true
    return try Gozd_V1_ProjectConfig(jsonString: json, options: options)
  }

  public func save(dir: String, config: Gozd_V1_ProjectConfig) throws {
    let path = filePath(for: dir)
    let parentDir = (path as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(
      atPath: parentDir, withIntermediateDirectories: true)
    let json = try config.jsonString()
    try json.write(toFile: path, atomically: true, encoding: .utf8)
  }

  private func filePath(for dir: String) -> String {
    // 呼び出し元（renderer）は active worktree の path を渡してくる場合があるため、
    // main repo root に解決してから projectKey を算出する。これで main / worktree / subdir のどこから
    // 開いても同じ config.json を参照する。
    let projectKey = ProjectKey.resolveAndCompute(for: dir)
    return (configDir as NSString)
      .appendingPathComponent("projects")
      .appending("/\(projectKey)/config.json")
  }
}
