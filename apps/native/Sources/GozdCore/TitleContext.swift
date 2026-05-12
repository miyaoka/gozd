import Foundation
import Observation

/// Toolbar の principal 位置に出す「現在 active な repo / worktree」の表示文字列。
/// renderer 側で active worktree が変わるたびに `/window/setTitleContext` RPC で更新する。
/// SwiftUI 側の ContentView が `@State` で参照し、`text` 更新で toolbar が再 render する。
///
/// セマンティクス: latest-wins。RPC は 1 ハンドラ 1 書き込みで `MainActor.run` 内で
/// 同期完結するため、renderer 側で連続して push が来ても最終的に最後に届いた値で確定する。
/// 古い値を捨てる順序管理は呼び出し側が持つ（renderer 側 `useTitleContextSync` の
/// `watch` は値が変化したときのみ発火するため、古い値が後から上書きされる経路は無い）。
@Observable @MainActor
public final class TitleContext {
  public static let shared = TitleContext()
  /// 例: "gozd · 20260511_194304"。空のときは ContentView 側で windowTitle にフォールバックする
  public var text: String = ""
  private init() {}
}
