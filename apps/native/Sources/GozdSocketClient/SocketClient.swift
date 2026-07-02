import Darwin
import Foundation

// Unix Domain Socket クライアント送信の SSOT。
//
// gozd-cli の本番送信路 (`GozdCLI.sendOrExit`) と SocketServerTests の test helper が
// 同一実装を共有する。かつては両者が同じ POSIX socket パターンを手写しで重複させており、
// SO_NOSIGPIPE 欠落のような欠陥修正が一方に伝播しない構造だったため、単一 owner に集約した。
//
// `GozdCore` に畳まず専用の軽量 target にする理由: gozd-cli は Claude hooks の
// イベントごとに起動される短命プロセスで、CPty / Network / FSEvents / git ops を抱える
// `GozdCore` をリンクすると binary 肥大と初期化コストを負う (高頻度イベントを `nc` 直送に
// 逃がしている「CLI を軽く保つ」設計意図と逆行する)。本 target は Darwin + Foundation
// のみに依存する。
//
// 送信手順は spike `gozd-spike` で検証した必須パターン:
//   1. write-all
//   2. shutdown(SHUT_WR) で FIN を送信
//   3. read drain (EOF まで読む)
//   4. close
//
// 直接 `close` すると NWListener が accept する前に FIN が届いて受信されない race が
// 起きるため、shutdown + drain で server 側が読み終わるまで待つ必要がある。

public enum SocketClientError: Error, CustomStringConvertible {
  case createSocket(errno: Int32)
  case setNoSigpipe(errno: Int32)
  case pathTooLong
  case connect(errno: Int32)
  case write(errno: Int32)

  public var description: String {
    switch self {
    case .createSocket(let e): return "socket() failed: \(String(cString: strerror(e)))"
    case .setNoSigpipe(let e):
      return "setsockopt(SO_NOSIGPIPE) failed: \(String(cString: strerror(e)))"
    case .pathTooLong: return "socket path too long"
    case .connect(let e): return "connect() failed: \(String(cString: strerror(e)))"
    case .write(let e): return "write() failed: \(String(cString: strerror(e)))"
    }
  }
}

/// 短命接続で 1 ペイロードを送り、server 側の受信完了 (EOF) まで待って返る。
public func sendOverUnixSocket(path: String, payload: Data) throws {
  let fd = try makeClientSocket()
  defer { close(fd) }
  try connectUnix(fd: fd, path: path)
  try writeAll(fd: fd, data: payload)
  shutdown(fd, Int32(SHUT_WR))
  drainUntilEOF(fd: fd)
}

/// SO_NOSIGPIPE 設定済みのクライアント socket fd を作る。
///
/// SO_NOSIGPIPE: peer が connection を close / reset した後の write は、これが無いと
/// EPIPE ではなく SIGPIPE をプロセス全体に配送する (default action は terminate)。
/// gozd-cli では hook イベントが stderr 出力もなく silent に消え、swift-testing では
/// 全 suite を単一プロセスで並列実行するため 1 回の race で swiftpm-testing-helper ごと
/// signal 13 死して全テストが巻き添えになる (CI でのみ再現する flaky crash の正体)。
/// 設定後は write が EPIPE を返し、`SocketClientError.write` として観察可能に throw される。
func makeClientSocket() throws -> Int32 {
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else { throw SocketClientError.createSocket(errno: errno) }
  var noSigpipe: Int32 = 1
  guard
    setsockopt(
      fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, socklen_t(MemoryLayout<Int32>.size)) == 0
  else {
    let e = errno
    close(fd)
    throw SocketClientError.setNoSigpipe(errno: e)
  }
  return fd
}

func connectUnix(fd: Int32, path: String) throws {
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let pathBytes = Array(path.utf8)
  let maxLen = MemoryLayout.size(ofValue: addr.sun_path) - 1
  guard pathBytes.count <= maxLen else { throw SocketClientError.pathTooLong }
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
  guard connectResult == 0 else { throw SocketClientError.connect(errno: errno) }
}

/// write-all (部分書き込みに loop 対応、EINTR は retry)。
func writeAll(fd: Int32, data: Data) throws {
  try data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
    var remaining = buf.count
    guard var ptr = buf.baseAddress else { return }
    while remaining > 0 {
      let written = Darwin.write(fd, ptr, remaining)
      if written < 0 {
        if errno == EINTR { continue }
        throw SocketClientError.write(errno: errno)
      }
      remaining -= written
      ptr = ptr.advanced(by: written)
    }
  }
}

/// server 側が EOF まで読み取って close するのを待つ (EINTR は retry)。
func drainUntilEOF(fd: Int32) {
  var drainBuf = [UInt8](repeating: 0, count: 256)
  while true {
    let n = drainBuf.withUnsafeMutableBufferPointer {
      Darwin.read(fd, $0.baseAddress, $0.count)
    }
    if n > 0 { continue }
    if n < 0, errno == EINTR { continue }
    break
  }
}
