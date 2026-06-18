import Darwin
import Foundation
import GozdProto

// gozd CLI（Swift 版）。
//
// サブコマンド:
//   gozd open [path]   — 指定パスを開く（path 省略時は cwd）
//   gozd hook <event>  — Claude Code hooks から呼ばれて stdin の JSON を payload に詰める
//
// 通信は Unix Domain Socket NDJSON。proto3 JSON mapping で ClientMessage を 1 行送る。
// 対応する Swift desktop は SocketServer が NWListener で受ける。
//
// 設計判断:
// - swift-protobuf を使って ClientMessage をエンコード（型 SSOT を壊さない）
// - 接続後の write→shutdown(SHUT_WR)→drain→close は spike で確認した必須パターン
// - 短命プロセスのため `Foundation.Process` 等の重い API は避ける

// socket / launch dir で共有する prefix。`Gozd.bundlePrefix` と同じ値に揃える。
// main.swift では top-level let が逐次実行されるため、switch から呼ばれる
// 関数（launchRequestDir / socketPath）が参照する `bundlePrefix` は switch より
// 前で必ず初期化されている必要がある。
let bundlePrefix = "gozd"

let args = CommandLine.arguments
let firstArg = args.count >= 2 ? args[1] : nil

switch firstArg {
case nil:
  await openCommand(target: ".")
case "open":
  let target = args.count >= 3 ? args[2] : "."
  await openCommand(target: target)
case "hook":
  guard args.count >= 3 else {
    FileHandle.standardError.write(Data("usage: gozd hook <event>\n".utf8))
    exit(2)
  }
  await hookCommand(event: args[2])
case "--version", "-v":
  print("gozd 0.0.0")
case "--help", "-h":
  printUsage()
case let .some(arg):
  // `gozd hook` / `gozd open` / `--*` 以外で先頭引数が来たら open のパスとみなす。
  // 旧版（Bun CLI）が `gozd <path>` を直接受けていた挙動に合わせる。
  await openCommand(target: arg)
}

func printUsage() {
  let usage = """
    gozd - Git Orchestrated Zone for Development

    Usage:
      gozd [path]        Open the given path in gozd (default: current directory)
      gozd open [path]   Same as above (explicit subcommand form)
      gozd hook <event>  Forward a Claude Code hook event (called by hooks)
      gozd --version     Print version
      gozd --help        Print this help

    Environment:
      GOZD_SOCKET_PATH  Override Unix socket path (default: $TMPDIR/gozd-{channel}.sock)
      GOZD_PTY_ID       Used by `hook` to attribute the event to a PTY
      GOZD_COLD_START   If set, `open` writes a launch request file instead of socket send
    """
  print(usage)
}

// MARK: - subcommands

func openCommand(target: String) async {
  // 絶対パス化（cwd 基準で resolve）
  let absolute = absolutePath(target)

  // cold start: socket が無い前提で launch request ファイルを書き出す
  // （Phase 4 の `bin/gozd` シェルラッパーがアプリ未起動時にこの経路を取らせる）
  if ProcessInfo.processInfo.environment["GOZD_COLD_START"] != nil {
    do {
      try writeLaunchRequest(targetPath: absolute)
    } catch {
      FileHandle.standardError.write(
        Data("Failed to write launch request: \(error)\n".utf8))
      exit(1)
    }
    return
  }

  // warm start: ソケット送信
  var open = Gozd_V1_OpenMessage()
  open.targetPath = absolute
  var msg = Gozd_V1_ClientMessage()
  msg.body = .open(open)
  await sendOrExit(message: msg)
}

func hookCommand(event: String) async {
  // stdin から Claude Code が渡す JSON を読む（空でも可）
  let stdinData = FileHandle.standardInput.readDataToEndOfFile()
  let stdinText = String(decoding: stdinData, as: UTF8.self).trimmingCharacters(
    in: .whitespacesAndNewlines)
  let stdinJson: [String: Any]
  if stdinText.isEmpty {
    stdinJson = [:]
  } else if let parsed = try? JSONSerialization.jsonObject(with: Data(stdinText.utf8))
    as? [String: Any]
  {
    stdinJson = parsed
  } else {
    stdinJson = [:]
  }

  var hook = Gozd_V1_HookMessage()
  hook.event = event
  if let ptyIdStr = ProcessInfo.processInfo.environment["GOZD_PTY_ID"],
    let ptyId = UInt32(ptyIdStr)
  {
    hook.ptyID = ptyId
  }
  // Claude Code が渡す代表的なフィールドを HookMessage に詰める
  if let last = stdinJson["last_assistant_message"] as? String {
    hook.lastAssistantMessage = last
  }
  if let toolName = stdinJson["tool_name"] as? String {
    hook.toolName = toolName
  }
  if let toolInput = stdinJson["tool_input"] {
    if let s = toolInput as? String {
      hook.toolInput = s
    } else if let d = try? JSONSerialization.data(withJSONObject: toolInput),
      let s = String(data: d, encoding: .utf8)
    {
      hook.toolInput = s
    }
  }
  if let isInterrupt = stdinJson["is_interrupt"] as? Bool {
    hook.isInterrupt = isInterrupt
  }
  if let sessionId = stdinJson["session_id"] as? String {
    hook.sessionID = sessionId
  }
  if let source = stdinJson["source"] as? String {
    hook.source = source
  }
  // Stop (done) フックの stdin に乗る pending work シグナル (Claude Code v2.1.145+)。
  // background_tasks: run_in_background / 非同期 Agent / Monitor
  // session_crons: /loop / ScheduleWakeup / CronCreate
  // どちらかが残っていれば主エージェントのターンは終わったが裏で作業継続中 = 真の done ではない。
  // 旧バージョンでは両キーが欠落するが、その場合は count 0 = pending なしで正しい (欠落 == 空)。
  let backgroundCount = (stdinJson["background_tasks"] as? [Any])?.count ?? 0
  let cronCount = (stdinJson["session_crons"] as? [Any])?.count ?? 0
  hook.pendingWork = backgroundCount + cronCount > 0

  var msg = Gozd_V1_ClientMessage()
  msg.body = .hook(hook)
  await sendOrExit(message: msg)
}

// MARK: - helpers

func absolutePath(_ path: String) -> String {
  if path.hasPrefix("/") { return (path as NSString).standardizingPath }
  let cwd = FileManager.default.currentDirectoryPath
  return ((cwd as NSString).appendingPathComponent(path) as NSString).standardizingPath
}

func socketPath() -> String {
  if let env = ProcessInfo.processInfo.environment["GOZD_SOCKET_PATH"], !env.isEmpty {
    return env
  }
  // fallback: stable channel
  let tmp = NSTemporaryDirectory()
  return (tmp as NSString).appendingPathComponent("\(bundlePrefix)-stable.sock")
}

func launchRequestDir() -> String {
  let tmp = NSTemporaryDirectory()
  // GOZD_SOCKET_PATH からチャネル名を抽出して $TMPDIR/{bundlePrefix}-{channel}-launch/ を返す
  let sock = socketPath()
  let base = (sock as NSString).lastPathComponent
  let prefix = "\(bundlePrefix)-"
  if base.hasPrefix(prefix), base.hasSuffix(".sock") {
    let start = base.index(base.startIndex, offsetBy: prefix.count)
    let end = base.index(base.endIndex, offsetBy: -".sock".count)
    let channel = String(base[start..<end])
    return (tmp as NSString).appendingPathComponent("\(bundlePrefix)-\(channel)-launch")
  }
  return (tmp as NSString).appendingPathComponent("\(bundlePrefix)-stable-launch")
}

func writeLaunchRequest(targetPath: String) throws {
  let dir = launchRequestDir()
  try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
  let file = (dir as NSString).appendingPathComponent(UUID().uuidString + ".json")
  let json = try JSONSerialization.data(
    withJSONObject: ["targetPath": targetPath], options: [])
  try json.write(to: URL(fileURLWithPath: file))
}

/// 短命接続で 1 メッセージを送って終了する。失敗時は stderr + exit 1。
///
/// spike `gozd-spike` で検証した必須パターン:
///   1. write
///   2. shutdown(fd, SHUT_WR) で FIN を送信
///   3. read drain（EOF まで読む）
///   4. close
///
/// 直接 `close` すると NWListener が accept する前に FIN が届いて受信されない race が
/// 起きるため、shutdown + drain で読み終わるまで待つ必要がある。
func sendOrExit(message: Gozd_V1_ClientMessage) async {
  let payload: Data
  do {
    payload = try message.jsonUTF8Data() + Data("\n".utf8)
  } catch {
    FileHandle.standardError.write(
      Data("Failed to encode message: \(error)\n".utf8))
    exit(1)
  }

  let path = socketPath()
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  if fd < 0 {
    FileHandle.standardError.write(
      Data("Failed to create socket: \(String(cString: strerror(errno)))\n".utf8))
    exit(1)
  }
  defer { close(fd) }

  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let pathBytes = Array(path.utf8)
  let maxLen = MemoryLayout.size(ofValue: addr.sun_path) - 1
  if pathBytes.count > maxLen {
    FileHandle.standardError.write(
      Data("Socket path too long: \(path)\n".utf8))
    exit(1)
  }
  withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
    let buf = UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: CChar.self)
    for (i, byte) in pathBytes.enumerated() {
      buf[i] = CChar(bitPattern: byte)
    }
    buf[pathBytes.count] = 0
  }

  let connectResult = withUnsafePointer(to: &addr) { ptr in
    ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
      Darwin.connect(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
  }
  if connectResult < 0 {
    let code = errno
    if code == ENOENT || code == ECONNREFUSED {
      FileHandle.standardError.write(Data("gozd app is not running\n".utf8))
    } else {
      FileHandle.standardError.write(
        Data("Failed to connect: \(String(cString: strerror(code)))\n".utf8))
    }
    exit(1)
  }

  // write
  payload.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
    var remaining = buf.count
    var ptr = buf.baseAddress!
    while remaining > 0 {
      let written = Darwin.write(fd, ptr, remaining)
      if written < 0 {
        FileHandle.standardError.write(
          Data("write failed: \(String(cString: strerror(errno)))\n".utf8))
        exit(1)
      }
      remaining -= written
      ptr = ptr.advanced(by: written)
    }
  }

  // shutdown(SHUT_WR) で書き終わりを通知してから drain
  shutdown(fd, Int32(SHUT_WR))
  var drainBuf = [UInt8](repeating: 0, count: 256)
  while true {
    let n = drainBuf.withUnsafeMutableBufferPointer {
      Darwin.read(fd, $0.baseAddress, $0.count)
    }
    if n <= 0 { break }
  }
}
