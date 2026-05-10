import Foundation

// `gozd` shell コマンドを `~/.local/bin/gozd` に symlink で配置 / 削除する。
//
// VSCode の「Shell Command: Install 'code' command in PATH」と同じ思想だが、
// `/usr/local/bin` ではなく `~/.local/bin` を使うため `osascript` 権限昇格は不要。
//
// target は `.app/Contents/Resources/app/bin/gozd`（shell wrapper）。
// `gozd-cli`（Swift バイナリ）ではなく wrapper を指す理由:
//   - wrapper が cold/warm start を判定して socket 経路 / `open` 経路を切り替える
//   - bypass すると hook 用の起動連携が壊れる

public enum ShellCommandError: Error, Equatable {
  /// `.app` 内 `Resources/app/bin/gozd` が見つからない（dev `.app` 起動 / 未ビルド時）
  case targetNotFound(String)
  /// `~/.local/bin/gozd` に既に regular file（symlink ではない）が存在する
  case sourceIsRegularFile(String)
}

public enum ShellCommandOps {
  public static func sourcePath() -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return (home as NSString).appendingPathComponent(".local/bin/gozd")
  }

  /// `.app` 内 wrapper の絶対パス。dev `.app` には wrapper が含まれないため
  /// `targetNotFound` を投げる。
  public static func targetPath() throws -> String {
    guard let resourceURL = Bundle.main.resourceURL else {
      throw ShellCommandError.targetNotFound("Bundle.main.resourceURL is nil")
    }
    let path = resourceURL.appendingPathComponent("app/bin/gozd").path
    guard FileManager.default.isExecutableFile(atPath: path) else {
      throw ShellCommandError.targetNotFound(path)
    }
    return path
  }

  public struct InstallResult {
    public let source: String
    public let target: String
    public let alreadyInstalled: Bool
    public let replaced: Bool
  }

  public static func install() throws -> InstallResult {
    let source = sourcePath()
    let target = try targetPath()
    let fm = FileManager.default

    // 親ディレクトリ（`~/.local/bin`）を必要なら作る。
    let parent = (source as NSString).deletingLastPathComponent
    if !fm.fileExists(atPath: parent) {
      try fm.createDirectory(atPath: parent, withIntermediateDirectories: true)
    }

    // 既存の symlink を点検。
    if let existingTarget = try? fm.destinationOfSymbolicLink(atPath: source) {
      // 相対 symlink にも対応するため絶対パスに正規化してから比較。
      let resolved =
        (existingTarget as NSString).isAbsolutePath
        ? existingTarget
        : (parent as NSString).appendingPathComponent(existingTarget)
      let normalizedExisting = URL(fileURLWithPath: resolved).standardized.path
      let normalizedTarget = URL(fileURLWithPath: target).standardized.path
      if normalizedExisting == normalizedTarget {
        return InstallResult(
          source: source, target: target, alreadyInstalled: true, replaced: false)
      }
      // 別の `.app`（旧版 / dev / Insiders 相当）を指す symlink は上書きする。
      try fm.removeItem(atPath: source)
      try fm.createSymbolicLink(atPath: source, withDestinationPath: target)
      return InstallResult(source: source, target: target, alreadyInstalled: false, replaced: true)
    }

    // symlink ではない通常ファイルが存在する場合は上書きしない（ユーザーが置いた
    // 可能性があるため）。
    if fm.fileExists(atPath: source) {
      throw ShellCommandError.sourceIsRegularFile(source)
    }

    try fm.createSymbolicLink(atPath: source, withDestinationPath: target)
    return InstallResult(source: source, target: target, alreadyInstalled: false, replaced: false)
  }

  public struct UninstallResult {
    public let source: String
    public let removed: Bool
    public let notInstalled: Bool
  }

  /// この `.app` の wrapper を指す symlink のみ削除する。
  /// 他の `.app` を指す symlink や regular file には触らない（誤削除防止）。
  public static func uninstall() throws -> UninstallResult {
    let source = sourcePath()
    let fm = FileManager.default

    guard let existingTarget = try? fm.destinationOfSymbolicLink(atPath: source) else {
      return UninstallResult(source: source, removed: false, notInstalled: true)
    }

    let parent = (source as NSString).deletingLastPathComponent
    let resolved =
      (existingTarget as NSString).isAbsolutePath
      ? existingTarget
      : (parent as NSString).appendingPathComponent(existingTarget)
    let normalizedExisting = URL(fileURLWithPath: resolved).standardized.path

    // target 解決失敗（dev `.app` で uninstall されたケース）でも source が
    // この .app 配下にあれば消す、という判定にすると意外性があるため、
    // 「target を解決できる かつ 一致する」ときのみ消す方針にする。
    guard let target = try? targetPath() else {
      return UninstallResult(source: source, removed: false, notInstalled: false)
    }
    let normalizedTarget = URL(fileURLWithPath: target).standardized.path

    if normalizedExisting == normalizedTarget {
      try fm.removeItem(atPath: source)
      return UninstallResult(source: source, removed: true, notInstalled: false)
    }
    return UninstallResult(source: source, removed: false, notInstalled: false)
  }
}
