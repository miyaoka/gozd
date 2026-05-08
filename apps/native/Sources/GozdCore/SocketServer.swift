import Darwin
import Foundation
import Network

// Unix Domain Socket 上で NDJSON（改行区切り JSON）を受け取る軽量サーバー。
// CLI（`gozd open <path>` 等）→ desktop の通信路として使う。
//
// 設計判断（spike `gozd-spike` で検証済み）:
//
// 1. **`@unchecked Sendable` を付けない**。FSWatcher / PTYManager と同じ流儀。
//    単一 context（@MainActor または専用 actor）から所有・操作する前提。
//
// 2. **NWParameters の組み立てパターン**（Apple DTS Quinn 公式回答 -
//    [Forums #719635](https://developer.apple.com/forums/thread/719635) /
//    [#756756](https://developer.apple.com/forums/thread/756756)）:
//    空 init してから `transportProtocol` に `NWProtocolTCP.Options()` を代入する。
//    `NWParameters.tcp`（プリセット）は Unix endpoint と組み合わせて使えない。
//
// 3. **接続の retain は connection の自己参照 closure に任せる**。spike のように
//    辞書で NWConnection を保持する必要はない。stateUpdateHandler を
//    `{ ... captures connection ... }` で設定すれば暗黙に生き残り、`.cancelled`
//    遷移時に Network framework が handler を release してサイクルを切る。
//
// 4. **Swift 6 strict concurrency 対策**: newConnectionHandler / receive callback は
//    `@Sendable` 必須。non-Sendable self をキャプチャしないため、接続処理は自由関数
//    （free function）として切り出す。closure には Sendable な値だけを渡す。
public final class SocketServer {
  public typealias MessageHandler = @Sendable (Data) -> Void

  private let socketPath: String
  private let queue: DispatchQueue
  private var listener: NWListener?

  public init(socketPath: String) {
    self.socketPath = socketPath
    self.queue = DispatchQueue(label: "io.github.miyaoka.gozd.SocketServer")
  }

  deinit {
    listener?.cancel()
    unlink(socketPath)
  }

  /// listen を開始する。1 行（`\n` 区切り）受信するごとに `onMessage` が呼ばれる。
  /// バックグラウンドキューから呼ばれるため、handler 側でスレッド安全性を確保すること。
  public func start(onMessage: @escaping MessageHandler) throws {
    guard listener == nil else { return }
    unlink(socketPath)

    let params = NWParameters()
    params.defaultProtocolStack.transportProtocol = NWProtocolTCP.Options()
    params.requiredLocalEndpoint = NWEndpoint.unix(path: socketPath)
    params.allowLocalEndpointReuse = true

    let listener = try NWListener(using: params)
    let queue = self.queue
    listener.newConnectionHandler = { connection in
      handleConnection(connection: connection, queue: queue, onMessage: onMessage)
    }
    listener.start(queue: queue)
    self.listener = listener
  }

  public func stop() {
    listener?.cancel()
    listener = nil
    unlink(socketPath)
  }
}

// MARK: - private helpers (free functions to avoid self capture in @Sendable closures)

private func handleConnection(
  connection: NWConnection,
  queue: DispatchQueue,
  onMessage: @escaping @Sendable (Data) -> Void
) {
  // stateUpdateHandler が connection を捕捉することで retain を維持する。
  // Apple DTS 公式回答: connection.start(queue:) 直後に receive を呼ばず、
  // `.ready` に遷移してから receive を開始する。
  connection.stateUpdateHandler = { state in
    switch state {
    case .ready:
      receiveLoop(connection: connection, buffer: Data(), onMessage: onMessage)
    case .failed, .cancelled:
      connection.cancel()
    default:
      break
    }
  }
  connection.start(queue: queue)
}

private func receiveLoop(
  connection: NWConnection,
  buffer: Data,
  onMessage: @escaping @Sendable (Data) -> Void
) {
  connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) {
    data, _, isComplete, error in
    var current = buffer
    if let data, !data.isEmpty {
      current.append(data)
      while let nl = current.firstIndex(of: 0x0A) {
        let line = current.subdata(in: current.startIndex..<nl)
        current.removeSubrange(current.startIndex...nl)
        if !line.isEmpty {
          onMessage(line)
        }
      }
    }
    if error != nil || isComplete {
      // 残った buffer は不完全な行として捨てる。CLI 側は必ず `\n` で終端する規約。
      connection.cancel()
      return
    }
    receiveLoop(connection: connection, buffer: current, onMessage: onMessage)
  }
}
