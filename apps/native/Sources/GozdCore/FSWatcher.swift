import CoreServices
import Foundation

// FSEvents をラップする再帰的ファイル監視。
//
// 設計判断（spike `gozd-spike` で検証済み）:
//
// 1. **`@unchecked Sendable` を付けない**。Sendable 適合させない non-Sendable class とする。
//    - Swift 6 analyzer は non-Sendable class を見ると cross-actor 送信不可で打ち切り、
//      内部の OpaquePointer (FSEventStreamRef) を解析しない。
//    - 逆に @unchecked Sendable を付けると analyzer が「Sendable と称するなら検証する」
//      モードに入り、OpaquePointer を持つフィールドで SendNonSendable パスがクラッシュする
//      （Swift 6.3 / Xcode 26 で実測）。
//    - 利用側は単一 context（@MainActor または専用 actor）から使う前提。
//    - これは Apple `swift-tools-support-core/Sources/TSCUtility/FSWatch.swift` の流儀と同じ。
//
// 2. **必須 flag**: `FileEvents | NoDefer | UseCFTypes`。
//    - `UseCFTypes` がないと `eventPaths` は `char**` で、`unsafeBitCast(_, to: NSArray.self)`
//      が UB → SIGSEGV。
//    - `FileEvents`: ディレクトリ単位ではなくファイル単位のイベントを受け取る。
//    - `NoDefer`: バッチの最初のイベントを即時 dispatch、以降を coalesce。
//
// 3. **採用しなかった flag**:
//    - `WatchRoot`: gozd の現用途（worktree 配下監視）では root 移動シナリオが希。必要時に追加検討。
//    - `IgnoreSelf`: gozd 経由（PTY spawn 等）の書き込みも UI 更新したいので不採用。
public final class FSWatcher {
  public struct Event {
    public let path: String
    public let flags: FSEventStreamEventFlags
    public let id: FSEventStreamEventId
  }

  public typealias Handler = ([Event]) -> Void

  private let paths: [String]
  private let latency: CFTimeInterval
  private let queue: DispatchQueue
  private var stream: FSEventStreamRef?
  private var handler: Handler?

  public init(paths: [String], latency: TimeInterval = 0.1) {
    self.paths = paths
    self.latency = latency
    self.queue = DispatchQueue(label: "io.github.miyaoka.gozd.FSWatcher")
  }

  public func setHandler(_ handler: @escaping Handler) {
    self.handler = handler
  }

  public func start() throws {
    guard stream == nil else { return }

    var context = FSEventStreamContext(
      version: 0,
      info: Unmanaged.passUnretained(self).toOpaque(),
      retain: nil,
      release: nil,
      copyDescription: nil
    )

    let flags: FSEventStreamCreateFlags =
      UInt32(kFSEventStreamCreateFlagFileEvents)
      | UInt32(kFSEventStreamCreateFlagNoDefer)
      | UInt32(kFSEventStreamCreateFlagUseCFTypes)

    guard
      let stream = FSEventStreamCreate(
        kCFAllocatorDefault,
        fsWatcherCallback,
        &context,
        paths as CFArray,
        FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
        latency,
        flags
      )
    else {
      throw FSWatcherError.streamCreationFailed
    }

    FSEventStreamSetDispatchQueue(stream, queue)
    if !FSEventStreamStart(stream) {
      FSEventStreamInvalidate(stream)
      FSEventStreamRelease(stream)
      throw FSWatcherError.streamStartFailed
    }
    self.stream = stream
  }

  public func stop() {
    guard let stream = stream else { return }
    FSEventStreamStop(stream)
    FSEventStreamInvalidate(stream)
    FSEventStreamRelease(stream)
    self.stream = nil
  }

  deinit {
    if let stream = stream {
      FSEventStreamStop(stream)
      FSEventStreamInvalidate(stream)
      FSEventStreamRelease(stream)
    }
  }

  fileprivate func dispatch(_ events: [Event]) {
    handler?(events)
  }
}

public enum FSWatcherError: Error {
  case streamCreationFailed
  case streamStartFailed
}

private func fsWatcherCallback(
  streamRef: ConstFSEventStreamRef,
  clientCallBackInfo: UnsafeMutableRawPointer?,
  numEvents: Int,
  eventPaths: UnsafeMutableRawPointer,
  eventFlags: UnsafePointer<FSEventStreamEventFlags>,
  eventIds: UnsafePointer<FSEventStreamEventId>
) {
  guard let info = clientCallBackInfo else { return }
  let watcher = Unmanaged<FSWatcher>.fromOpaque(info).takeUnretainedValue()
  // UseCFTypes flag が立っているので eventPaths は CFArray<CFString>。
  let pathsArray = unsafeBitCast(eventPaths, to: NSArray.self) as? [String] ?? []

  var events: [FSWatcher.Event] = []
  events.reserveCapacity(numEvents)
  for i in 0..<numEvents {
    guard i < pathsArray.count else { break }
    events.append(
      FSWatcher.Event(
        path: pathsArray[i],
        flags: eventFlags[i],
        id: eventIds[i]
      ))
  }
  watcher.dispatch(events)
}
