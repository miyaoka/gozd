import Foundation
import Observation

/// Toolbar の principal 位置に出す「現在 active な repo / worktree」の表示文字列。
/// renderer 側で active worktree が変わるたびに `/window/setTitleContext` RPC で更新する。
/// SwiftUI 側の ContentView が `@State` で参照し、`text` 更新で toolbar が再 render する。
@Observable @MainActor
public final class TitleContext {
  public static let shared = TitleContext()
  /// 例: "gozd · 20260511_194304"。空のときは ContentView 側で windowTitle にフォールバックする
  public var text: String = ""
  private init() {}
}
