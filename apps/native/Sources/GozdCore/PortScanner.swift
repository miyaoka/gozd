import CProc
import Darwin
import Foundation

// 実行中サーバー (TCP LISTEN プロセス) を定期ポーリングで検出する actor (issue #768)。
//
// macOS にはソケットの LISTEN 開始を通知する event API が無いため、`CProc` 経由で
// 全プロセスの LISTEN ソケットを周期スキャンする。各 LISTEN プロセスの ppid チェーンを
// 辿り、祖先が gozd PTY の子プロセスなら当該 worktree に帰属させる。
//
// 帰属の 3 分類:
//   - live:     生きている PTY の子孫。worktreePath / ptyId が有効
//   - orphaned: 過去に live 帰属したが PTY が消滅 (ターミナルを閉じた後も port を掴む)
//   - external: gozd 外のプロセス
//
// snapshot は前回と差分があるときだけ onSnapshot に渡す (callJavaScript の churn 抑制)。
// renderer mount 時の初回 hydrate は `currentSnapshot()` を pull する RPC が担う。

/// 検出した 1 サーバープロセス。同一 pid が複数 port を持つ場合は ports に集約する。
public struct DetectedServer: Sendable, Equatable {
  public enum Attribution: String, Sendable {
    case live
    case orphaned
    case external
  }
  public let pid: Int32
  public let name: String
  public let ports: [UInt16]
  public let attribution: Attribution
  /// live / orphaned のとき帰属先 worktree の絶対パス。external は空。
  public let worktreePath: String
  /// live のとき帰属先 PTY id。それ以外は 0。
  public let ptyId: UInt32
}

public actor PortScanner {
  public typealias SnapshotHandler = @Sendable ([DetectedServer]) -> Void

  // ppid チェーンを辿る最大段数。循環 / 異常な親子関係でも無限ループしない安全弁。
  private static let maxAncestryDepth = 64
  // gozd_list_listen_ports に渡す buffer 上限。実用域 (数十) を大きく上回る値。
  private static let listenBufferCapacity = 4096

  private let registry: PTYRegistry
  private let onSnapshot: SnapshotHandler
  private let intervalNanos: UInt64
  private var pollTask: Task<Void, Never>?

  // 一度 live 帰属した LISTEN pid → 最後に観測した worktreePath。PTY 消滅後に
  // orphaned 判定するために記憶する。プロセス消滅時に scan 末尾で掃除するため
  // 無制限には伸びない。pid 再利用の理論的リスクはあるが、観測のみで破壊操作は
  // しないため許容する。
  private var knownWorktreeByPid: [Int32: String] = [:]
  // 直近 snapshot。差分 push の比較と /server/list pull の応答に使う。
  private var lastSnapshot: [DetectedServer] = []

  public init(
    registry: PTYRegistry,
    intervalSeconds: Double = 3.0,
    onSnapshot: @escaping SnapshotHandler
  ) {
    self.registry = registry
    self.onSnapshot = onSnapshot
    self.intervalNanos = UInt64(intervalSeconds * 1_000_000_000)
  }

  /// ポーリングループを開始する。多重起動は無視する。
  public func start() {
    guard pollTask == nil else { return }
    let interval = intervalNanos
    pollTask = Task { [weak self] in
      // 初回は即座に scan する。起動直後の push が renderer mount 前で取りこぼされても、
      // mount 時の `/server/list` pull (currentSnapshot) が hydrate するため遅延は不要。
      while !Task.isCancelled {
        guard let self else { return }
        await self.scanOnce()
        try? await Task.sleep(nanoseconds: interval)
      }
    }
  }

  public func stop() {
    pollTask?.cancel()
    pollTask = nil
  }

  /// renderer mount 時の pull 応答用。直近 snapshot を返す。
  public func currentSnapshot() -> [DetectedServer] {
    return lastSnapshot
  }

  private func scanOnce() async {
    let listens = Self.listListenPorts()
    let procs = Self.listProcs()
    let childMap = await registry.childPidMap()

    var servers: [DetectedServer] = []
    servers.reserveCapacity(listens.count)
    for (pid, ports) in listens {
      let resolved = attribute(pid: pid, procs: procs, childMap: childMap)
      servers.append(
        DetectedServer(
          pid: pid,
          name: procs[pid]?.name ?? "",
          ports: ports.sorted(),
          attribution: resolved.attribution,
          worktreePath: resolved.worktreePath,
          ptyId: resolved.ptyId
        ))
    }
    // port 昇順 → pid 昇順で安定ソート。差分比較の安定性も担保する。
    servers.sort { lhs, rhs in
      let lp = lhs.ports.first ?? UInt16.max
      let rp = rhs.ports.first ?? UInt16.max
      return lp != rp ? lp < rp : lhs.pid < rhs.pid
    }

    // 消滅済み pid を記憶から掃除する (orphaned 記憶が無制限に伸びるのを防ぐ)。
    knownWorktreeByPid = knownWorktreeByPid.filter { procs[$0.key] != nil }

    guard servers != lastSnapshot else { return }
    lastSnapshot = servers
    onSnapshot(servers)
  }

  /// LISTEN pid の ppid チェーンを辿って帰属を解決する。
  private func attribute(
    pid: Int32,
    procs: [Int32: ProcInfo],
    childMap: [pid_t: (ptyId: UInt32, worktreePath: String)]
  ) -> (attribution: DetectedServer.Attribution, worktreePath: String, ptyId: UInt32) {
    var cursor = pid
    var depth = 0
    while cursor > 1 && depth < Self.maxAncestryDepth {
      if let owner = childMap[cursor] {
        // live 帰属。orphaned 判定用に記憶を更新する。
        knownWorktreeByPid[pid] = owner.worktreePath
        return (.live, owner.worktreePath, owner.ptyId)
      }
      guard let info = procs[cursor] else { break }
      cursor = info.ppid
      depth += 1
    }
    // PTY 配下ではない。過去に live 帰属していたなら orphaned。
    if let worktreePath = knownWorktreeByPid[pid] {
      return (.orphaned, worktreePath, 0)
    }
    return (.external, "", 0)
  }

  // MARK: - CProc bridge

  private struct ProcInfo {
    let ppid: Int32
    let name: String
  }

  /// 全プロセスの pid → (ppid, name)。probe で件数を得てから 1 度だけ確保する。
  private static func listProcs() -> [Int32: ProcInfo] {
    let needed = gozd_list_procs(nil, 0)
    guard needed > 0 else {
      if needed < 0 {
        StderrLog.write(tag: "PortScanner", "gozd_list_procs probe failed")
      }
      return [:]
    }
    // 走査中の増加に備えて余裕を持たせる。
    let capacity = Int(needed) + 128
    var buffer = [GozdProcEntry](repeating: GozdProcEntry(), count: capacity)
    let written = gozd_list_procs(&buffer, Int32(capacity))
    guard written >= 0 else {
      StderrLog.write(tag: "PortScanner", "gozd_list_procs failed")
      return [:]
    }
    let count = min(Int(written), capacity)
    var result: [Int32: ProcInfo] = [:]
    result.reserveCapacity(count)
    for index in 0..<count {
      let entry = buffer[index]
      result[entry.pid] = ProcInfo(ppid: entry.ppid, name: Self.cString(entry.name))
    }
    return result
  }

  /// 全 TCP LISTEN ソケットの pid → port 集合。
  private static func listListenPorts() -> [Int32: Set<UInt16>] {
    var buffer = [GozdListenEntry](
      repeating: GozdListenEntry(), count: listenBufferCapacity)
    let written = gozd_list_listen_ports(&buffer, Int32(listenBufferCapacity))
    guard written >= 0 else {
      StderrLog.write(tag: "PortScanner", "gozd_list_listen_ports failed")
      return [:]
    }
    if Int(written) > listenBufferCapacity {
      StderrLog.write(
        tag: "PortScanner",
        "listen ports truncated: \(written) > \(listenBufferCapacity)")
    }
    let count = min(Int(written), listenBufferCapacity)
    var result: [Int32: Set<UInt16>] = [:]
    for index in 0..<count {
      let entry = buffer[index]
      result[entry.pid, default: []].insert(entry.port)
    }
    return result
  }

  /// C の固定長 char 配列 (Swift では無名 tuple として import される) を String に変換する。
  /// C 側 (`gozd_list_procs`) は strlcpy で必ず NUL 終端するため、tuple 内に終端がある前提。
  private static func cString<T>(_ tuple: T) -> String {
    return withUnsafeBytes(of: tuple) { raw -> String in
      guard let base = raw.baseAddress else { return "" }
      return String(cString: base.assumingMemoryBound(to: CChar.self))
    }
  }
}
