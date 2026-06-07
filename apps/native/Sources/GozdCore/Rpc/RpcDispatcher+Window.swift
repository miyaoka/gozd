import AppKit
import Foundation
import GozdProto

// open / window / external 系 RPC handler。AppKit を介する MainActor 経路 (NSOpenPanel /
// NSWorkspace.open / NSApplication.terminate) を actor 内から MainActor.run でホップして扱う。

extension RpcDispatcher {
  func handlePickAndOpen(_ body: Data) async throws -> Data {
    _ = try Gozd_V1_PickAndOpenRequest(jsonUTF8Data: body)
    // NSOpenPanel は @MainActor。actor 内から MainActor.run でホップしてユーザー選択を待つ
    let pickedPath = await MainActor.run {
      let panel = NSOpenPanel()
      panel.canChooseDirectories = true
      panel.canChooseFiles = false
      panel.allowsMultipleSelection = false
      panel.prompt = "Open"
      panel.message = "Select a directory to open"
      let response = panel.runModal()
      if response == .OK, let url = panel.url {
        return url.path
      }
      return ""
    }
    if !pickedPath.isEmpty {
      onOpen(pickedPath)
    }
    return try Gozd_V1_PickAndOpenResponse().jsonUTF8Data()
  }

  /// `openExternal` で許可する URL scheme の allowlist。
  /// OSC 8 リンクや WebLinksAddon 経由で任意 scheme が流れ込み得るので、
  /// ブラウザで開く想定の scheme のみを許可する。テスト容易性のため純粋関数。
  static let openExternalAllowedSchemes: Set<String> = ["http", "https", "mailto"]

  static func isOpenExternalSchemeAllowed(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased() else { return false }
    return openExternalAllowedSchemes.contains(scheme)
  }

  func handleOpenExternal(_ body: Data) throws -> Data {
    let req = try Gozd_V1_OpenExternalRequest(jsonUTF8Data: body)
    guard let url = URL(string: req.url) else {
      throw RpcError.invalidArgument("invalid url: \(req.url)")
    }
    guard Self.isOpenExternalSchemeAllowed(url) else {
      throw RpcError.invalidArgument("scheme not allowed: \(url.scheme ?? "")")
    }
    // NSWorkspace.open は @MainActor。actor 内から MainActor.run でホップする。
    Task { @MainActor in
      NSWorkspace.shared.open(url)
    }
    return try Gozd_V1_OpenExternalResponse().jsonUTF8Data()
  }

  func handleWindowClose(_ body: Data) throws -> Data {
    _ = try Gozd_V1_WindowCloseRequest(jsonUTF8Data: body)
    Task { @MainActor in
      NSApplication.shared.terminate(nil)
    }
    return try Gozd_V1_WindowCloseResponse().jsonUTF8Data()
  }

  func handleWindowSetTitleContext(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_WindowSetTitleContextRequest(jsonUTF8Data: body)
    let repo = req.repoName
    let wt = req.worktreeName
    // "repo · worktree" 形式に整形。worktree 名が空なら repo 名のみ。
    let text: String
    if wt.isEmpty {
      text = repo
    } else if repo.isEmpty {
      text = wt
    } else {
      text = "\(repo) · \(wt)"
    }
    await MainActor.run {
      TitleContext.shared.text = text
    }
    return try Gozd_V1_WindowSetTitleContextResponse().jsonUTF8Data()
  }
}
