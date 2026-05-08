import CryptoKit
import Foundation
import GozdProto

// プロジェクト固有の設定永続化（`~/.config/gozd/projects/<projectKey>/config.json`）。
// projectKey は dir realpath の SHA-256 先頭 12 文字 + repoName。
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
    return try Gozd_V1_ProjectConfig(jsonString: json)
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
    let realpath = (dir as NSString).resolvingSymlinksInPath
    let repoName = (realpath as NSString).lastPathComponent
    let digest = SHA256.hash(data: Data(realpath.utf8))
    let hash = digest.compactMap { String(format: "%02x", $0) }.joined()
    let projectKey = "\(repoName)-\(String(hash.prefix(12)))"
    return (configDir as NSString)
      .appendingPathComponent("projects")
      .appending("/\(projectKey)/config.json")
  }
}
