import Darwin
import Foundation
import Testing

@testable import GozdSocketClient

// SO_NOSIGPIPE の回帰テスト。これが外れると peer close 後の write が EPIPE ではなく
// SIGPIPE をプロセス全体に配送し、swift-testing の単一プロセス並列実行では
// swiftpm-testing-helper ごと signal 13 死して全テストが巻き添えになる
// (CI でのみ再現していた flaky crash の正体)。gozd-cli では hook イベントの silent loss。
@Suite("GozdSocketClient")
struct SocketClientTests {
  @Test("makeClientSocket は SO_NOSIGPIPE 設定済みの fd を返す")
  func clientSocketHasNoSigpipe() throws {
    let fd = try makeClientSocket()
    defer { close(fd) }
    var value: Int32 = 0
    var len = socklen_t(MemoryLayout<Int32>.size)
    #expect(getsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &value, &len) == 0)
    #expect(value == 1)
  }

  @Test("peer close 済み socket への write は SIGPIPE ではなく EPIPE で throw する")
  func writeAfterPeerCloseThrowsEpipe() throws {
    // socketpair で peer を即 close し、「server が connection を reset した後に
    // client が write する」race の当たり側を決定的に再現する。SO_NOSIGPIPE が
    // 無ければこの write はプロセスを SIGPIPE で殺すため、テストが「fail する」
    // のではなく test runner ごと消える。throw で観測できること自体が修正の証明。
    var fds: [Int32] = [0, 0]
    #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
    defer { close(fds[0]) }
    var noSigpipe: Int32 = 1
    #expect(
      setsockopt(
        fds[0], SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, socklen_t(MemoryLayout<Int32>.size))
        == 0)
    close(fds[1])

    #expect {
      try writeAll(fd: fds[0], data: Data("x".utf8))
    } throws: { error in
      guard case SocketClientError.write(let e) = error else { return false }
      return e == EPIPE
    }
  }
}
