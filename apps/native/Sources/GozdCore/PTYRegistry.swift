import Darwin
import Foundation

/// PTY 子プロセスの pid を thread-safe に追跡するヘルパー。
///
/// applicationWillTerminate 等の同期コンテキストから「現在生きている全 PTY に
/// SIGHUP を送る」ためには actor 経由の async 呼び出しが取れないので、
/// non-actor の lock 付きラッパーを別管理する。
public final class PidTracker: @unchecked Sendable {
  private let lock = NSLock()
  private var pids: Set<pid_t> = []

  public init() {}

  public func add(_ pid: pid_t) {
    lock.lock()
    defer { lock.unlock() }
    pids.insert(pid)
  }

  public func remove(_ pid: pid_t) {
    lock.lock()
    defer { lock.unlock() }
    pids.remove(pid)
  }

  /// 現在追跡中の全 pid に SIGHUP を送る。送信自体は microseconds で済むため
  /// applicationWillTerminate 等の短時間ハンドラから安全に呼べる。
  public func killAll() {
    lock.lock()
    let snapshot = pids
    pids.removeAll()
    lock.unlock()
    for pid in snapshot {
      kill(pid, SIGHUP)
    }
  }
}

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
  private let pidTracker: PidTracker?
  private var ptys: [UInt32: PTYManager] = [:]
  private var consumers: [UInt32: Task<Void, Never>] = [:]
  // ptyId → 紐付く worktree の絶対パス。Claude セッションを worktree 単位で永続化する
  // ために hook 受信時に逆引きする。空文字 / 未登録なら無紐付け。
  private var worktreePathById: [UInt32: String] = [:]
  // ptyId → 直近に観測した Claude sessionId。session-start hook 受信で更新する。
  // unregisterPane 経由の削除 RPC（/claudeSession/removeByPty）が ptyId から sessionId を
  // 解決するために使う。/clear や --resume で sessionId が切り替わったときの旧 ID 削除も
  // 同じマッピングを参照する（applyClaudeSessionHook 側で比較）。
  private var sessionIdById: [UInt32: String] = [:]
  // ptyId → spawn 時の env[GOZD_RESUME_CLAUDE_SESSION] (resume 期待 sid)。
  // SessionStart hook (source=resume) が同じ sid で着弾したらクリアする。
  // unregisterPane 時点でも残っているなら resume 失敗 (claude --resume が transcript
  // 不在で error 終了したケース) と判定し、claude-sessions.json と task から該当 sid を
  // 掃除する。proactive な transcript 存在チェックを廃止した代わりの reactive 検出経路。
  private var expectedResumeSidById: [UInt32: String] = [:]
  // 削除 RPC で clearAssociations された ptyId 集合。late session-start hook が
  // 到達したとき、「明示削除後の late hook」と「そもそも未登録 PTY」を区別して
  // 観察ログを出すために使う（applyClaudeSessionHook 側で参照）。ptyId は
  // 単調増加で再利用されないので、PTY exit 後も残しておいて問題ない。
  private var explicitlyRemovedPtyIds: Set<UInt32> = []
  private var nextId: UInt32 = 1

  public init(
    onText: @escaping TextHandler,
    onExit: @escaping ExitHandler,
    envOverlay: GozdEnvOverlay? = nil,
    pidTracker: PidTracker? = nil
  ) {
    self.onText = onText
    self.onExit = onExit
    self.envOverlay = envOverlay
    self.pidTracker = pidTracker
  }

  public func spawn(
    executable: String,
    args: [String],
    env: [String: String],
    cwd: String,
    rows: UInt16,
    cols: UInt16,
    worktreePath: String = ""
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
    if !worktreePath.isEmpty {
      worktreePathById[id] = worktreePath
    }
    if let expected = env["GOZD_RESUME_CLAUDE_SESSION"], !expected.isEmpty {
      expectedResumeSidById[id] = expected
    }
    pidTracker?.add(pty.pid)

    let pidTracker = self.pidTracker
    let pidForCleanup = pty.pid

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
      pidTracker?.remove(pidForCleanup)
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

  /// hook 受信側が ptyId から worktreePath を逆引きするための accessor。
  public func worktreePath(for id: UInt32) -> String? {
    return worktreePathById[id]
  }

  /// 削除 RPC / hook ハンドラが ptyId から直近 sessionId を逆引きするための accessor。
  /// 未観測なら nil。
  public func sessionId(for id: UInt32) -> String? {
    return sessionIdById[id]
  }

  /// hook の session-start 受信時に呼ぶ。同 ptyId への複数 session-start（/clear や --resume）も
  /// 上書きで反映する。
  public func setSessionId(for id: UInt32, sessionId: String) {
    sessionIdById[id] = sessionId
  }

  /// 削除 RPC が sessionId を ClaudeSessionStore から消した後、マッピングをクリアする。
  public func clearSessionId(for id: UInt32) {
    sessionIdById.removeValue(forKey: id)
  }

  /// session-start (source=resume) で expected sid と一致したらクリアする。
  /// 一致時のみクリアすることで「同 PTY で別 sid に --resume し直した」ケース等で
  /// 古い expected を取り違えないようにする。
  public func clearExpectedResumeSidIfMatches(for id: UInt32, sessionId: String) {
    if expectedResumeSidById[id] == sessionId {
      expectedResumeSidById.removeValue(forKey: id)
    }
  }

  /// removeByPty 経路で「resume 失敗」検出のため expected sid を取り出してクリアする。
  /// 非空なら SessionStart hook が一度も着弾しないまま pane が閉じられた = resume が
  /// transcript 不在等で error 終了したケース。caller 側で claude-sessions / tasks の
  /// 該当 sid を片付ける。
  public func consumeExpectedResumeSid(for id: UInt32) -> String? {
    return expectedResumeSidById.removeValue(forKey: id)
  }

  /// unregisterPane 経由の削除 RPC から呼ぶ。worktreePath と sessionId の紐付けを
  /// 両方クリアする。意図: 削除 RPC 受信後に到達する late session-start hook を
  /// `applyClaudeSessionHook` の `!worktreePath.isEmpty` ガードで弾く。これにより
  /// 「Claude 起動直後の closePane」で発生しうる upsert → orphan エントリ race を防ぐ。
  /// 同時に explicitlyRemovedPtyIds に記録し、late hook の観察ログで「明示削除後」と
  /// 「未登録 PTY」を区別できるようにする。PTY 本体（ptys / consumers）は kill 経由で
  /// 別途解放されるのでここでは触らない。
  public func clearAssociations(for id: UInt32) {
    worktreePathById.removeValue(forKey: id)
    sessionIdById.removeValue(forKey: id)
    expectedResumeSidById.removeValue(forKey: id)
    explicitlyRemovedPtyIds.insert(id)
  }

  /// 削除 RPC で明示的に紐付けが消された ptyId かどうか。late hook ログの分岐に使う。
  public func wasExplicitlyRemoved(_ id: UInt32) -> Bool {
    return explicitlyRemovedPtyIds.contains(id)
  }

  private func remove(id: UInt32) {
    ptys.removeValue(forKey: id)
    consumers.removeValue(forKey: id)
    worktreePathById.removeValue(forKey: id)
    sessionIdById.removeValue(forKey: id)
    expectedResumeSidById.removeValue(forKey: id)
  }
}

private enum PTYEvent: Sendable {
  case data(Data)
  case exit(PTYExitReason)
}
