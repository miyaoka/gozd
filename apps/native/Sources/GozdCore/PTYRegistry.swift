import Foundation

// PTYManager のインスタンスを ID で管理する actor。
//
// 設計判断:
//
// 1. **actor を採用**。PTYManager は non-Sendable class（FSWatcher 流儀）なので、
//    `@unchecked Sendable` + lock で wrap するより actor 内に閉じ込めて isolation
//    を型システムに守らせる方が CLAUDE.md の規律に合う。
//
// 2. **handler を spawn の引数ではなく registry 初期化時に固定**。すべての PTY が
//    同じイベント経路（URLSchemeHandler から WebView へ callJavaScript）に流すため、
//    インスタンス毎に handler を渡す必要がない。
//
// 3. **PTY 終了時に自動で registry から削除**。onExit の中で `Task { await
//    self?.remove(id:) }` を発火し、actor の serial execution に削除を委ねる。
//    onExit 自体は PTYManager のバックグラウンド queue から呼ばれる。
public actor PTYRegistry {
  public typealias DataHandler = @Sendable (UInt32, Data) -> Void
  public typealias ExitHandler = @Sendable (UInt32, PTYExitReason) -> Void

  private let onData: DataHandler
  private let onExit: ExitHandler
  private var ptys: [UInt32: PTYManager] = [:]
  private var nextId: UInt32 = 1

  public init(onData: @escaping DataHandler, onExit: @escaping ExitHandler) {
    self.onData = onData
    self.onExit = onExit
  }

  public func spawn(
    executable: String,
    args: [String],
    env: [String: String],
    cwd: String,
    rows: UInt16,
    cols: UInt16
  ) throws -> UInt32 {
    let id = nextId
    nextId += 1

    // closure は @Sendable 必須なので self / pty を捕まえず、ID と外部 handler だけ
    // を捕捉する。後始末は Task で actor の serial execution に戻して処理する。
    let onData = self.onData
    let onExit = self.onExit
    let pty = PTYManager()
    try pty.spawn(
      executable: executable,
      args: args,
      env: env,
      cwd: cwd,
      rows: rows,
      cols: cols,
      onData: { data in onData(id, data) },
      onExit: { [weak self] reason in
        onExit(id, reason)
        Task { [weak self] in
          await self?.remove(id: id)
        }
      }
    )
    ptys[id] = pty
    return id
  }

  public func write(id: UInt32, data: Data) {
    ptys[id]?.write(data)
  }

  public func resize(id: UInt32, rows: UInt16, cols: UInt16) {
    ptys[id]?.resize(rows: rows, cols: cols)
  }

  public func kill(id: UInt32) {
    ptys[id]?.kill()
  }

  public func count() -> Int {
    ptys.count
  }

  private func remove(id: UInt32) {
    ptys.removeValue(forKey: id)
  }
}
