import Foundation

// `GitOps` は git CLI を Foundation `Process` 経由で呼ぶ RPC op の namespace。実装は責務別に
// `GitOps+<Op>.swift` (Status / Worktree / Branch / Log / Diff / Tree / Blame) に extension で
// 分割している。公開値型は `GitTypes.swift`、入力 validator は `GitValidate.swift`、
// process spawn / env は `GitRunner.swift` 側に閉じる。
//
// 戻り値は素の Swift 型（`[String: String]` 等）。proto 生成型への変換は RPC 境界
// (`RpcDispatcher` / URLSchemeHandler) で行う。ロジック層を proto に縛らないことで
// テスト容易性と将来の proto 変更耐性を確保する。

public enum GitOps {}

public enum GitError: Error, Equatable {
  case commandFailed(exitCode: Int32, stderr: String)
  case launchFailed(String)
  /// `command -v <name>` が空を返した = コマンドが未インストール。
  /// `launchFailed` (spawn/hang/起動エラー) と区別するため別 case。
  /// retry layer は `commandNotFound` を retry しない（invalidate しても再 spawn しても結果は同じ）。
  case commandNotFound(name: String)
  /// git は exit 0 で正常終了したが stdout のフォーマットが想定外。
  /// `commandFailed` は `exitCode != 0` を含意するため流用せず別 case にする。
  case unexpectedOutput(String)
}
