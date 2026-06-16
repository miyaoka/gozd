import Foundation
import Observation

/// サーバー一覧パネルの開閉状態を native titlebar のトグルボタンにミラーする状態 (issue #768)。
/// パネルの開閉は renderer が SSOT として所有し、変化のたびに `/window/setServerPanelOpen`
/// RPC で push する。SwiftUI 側の ToolbarItem が `@State` でこれを参照し、`isOpen` の変化で
/// ボタンの active 表示 (塗り) を更新する。TitleContext と同じ流儀。
///
/// セマンティクス: latest-wins。RPC は 1 ハンドラ 1 書き込みで `MainActor.run` 内に同期完結
/// するため、renderer 側で連続 push が来ても最後に届いた値で確定する。
@Observable @MainActor
public final class ServerPanelContext {
  public static let shared = ServerPanelContext()
  public var isOpen: Bool = false
  private init() {}
}
