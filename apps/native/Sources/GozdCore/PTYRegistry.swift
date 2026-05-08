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
// 3. **PTY 終了時に自動で registry から削除**。consumer Task が stream の終端で
//    flush → onExit → remove を順に処理する。
//
// 4. **イベントは AsyncStream<PTYEvent> で 1 本化**。順序保証のため:
//    - PTYManager の onData / onExit closure は別々の background queue から呼ばれる
//    - registry は data も exit も同じ AsyncStream に yield する
//    - 1 本の consumer Task が `for await` で順に処理する
//    - これにより `data → data → ... → flush → exit` の順序が機械的に保証される
//
// 5. **per-PTY UTF8StreamDecoder**。PTY の `read(fd, buf, 4096)` は UTF-8 マルチバイト
//    境界で割れる。decoder が末尾の不完全シーケンスを次回まで保留し、確定テキストのみ
//    外部 onText に渡す（spike `UTF8StreamDecoderTest` で検証済）。
public actor PTYRegistry {
  public typealias TextHandler = @Sendable (UInt32, String) -> Void
  public typealias ExitHandler = @Sendable (UInt32, PTYExitReason) -> Void

  private let onText: TextHandler
  private let onExit: ExitHandler
  private let envOverlay: GozdEnvOverlay?
  private var ptys: [UInt32: PTYManager] = [:]
  private var consumers: [UInt32: Task<Void, Never>] = [:]
  private var nextId: UInt32 = 1

  public init(
    onText: @escaping TextHandler,
    onExit: @escaping ExitHandler,
    envOverlay: GozdEnvOverlay? = nil
  ) {
    self.onText = onText
    self.onExit = onExit
    self.envOverlay = envOverlay
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

    let (stream, continuation) = AsyncStream<PTYEvent>.makeStream()

    let onText = self.onText
    let onExit = self.onExit

    // gozd env overlay があれば GOZD_* / ZDOTDIR / HOME を merge する。
    // ptyId 確定後に注入することで GOZD_PTY_ID が個別 PTY に紐付く。
    let mergedEnv = envOverlay?.merged(into: env, ptyId: id) ?? env

    let pty = PTYManager()
    try pty.spawn(
      executable: executable,
      args: args,
      env: mergedEnv,
      cwd: cwd,
      rows: rows,
      cols: cols,
      onData: { data in continuation.yield(.data(data)) },
      onExit: { reason in
        continuation.yield(.exit(reason))
        continuation.finish()
      }
    )
    ptys[id] = pty

    // consumer Task: AsyncStream の FIFO 順序保証で「全データ → flush → exit」が確定。
    // detached なので actor の isolation を待たずに即座に for-await を回せる。
    // 終端で `await self?.remove(id:)` で actor に hop してエントリを削除する。
    let task = Task.detached { [weak self] in
      var decoder = UTF8StreamDecoder()
      for await event in stream {
        switch event {
        case .data(let data):
          let text = decoder.feed(data)
          if !text.isEmpty { onText(id, text) }
        case .exit(let reason):
          let final = decoder.flush()
          if !final.isEmpty { onText(id, final) }
          onExit(id, reason)
        }
      }
      await self?.remove(id: id)
    }
    consumers[id] = task
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
    consumers.removeValue(forKey: id)
  }
}

private enum PTYEvent: Sendable {
  case data(Data)
  case exit(PTYExitReason)
}
