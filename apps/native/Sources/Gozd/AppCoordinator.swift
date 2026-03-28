import AppKit
import Darwin
import Foundation

/// アプリ全体のライフサイクルとウィンドウ間の協調を管理する
///
/// 単一インスタンスとして以下を所有する:
/// - SocketServer（CLI / hooks からのメッセージ受信）
/// - Claude hooks 設定（全 PTY 共通）
/// - PTY ID → ウィンドウのルーティングテーブル
/// - ウィンドウレジストリ（projectDir → ウィンドウ ID）
@Observable
final class AppCoordinator: @unchecked Sendable {
    let channel: String
    let socketPath: String
    let claudeSettingsPath: String

    private var server: SocketServer?

    /// PTY ID → ウィンドウ ID のマッピング（hook ルーティング用）
    private var ptyToWindow: [Int: String] = [:]

    /// ウィンドウ ID → hook イベント送信コールバック
    private var windowHookHandlers: [String: @Sendable (HookMessage) -> Void] = [:]

    /// projectDir → ウィンドウ ID のマッピング（ウィンドウ再利用判定用）
    private var projectDirToWindow: [String: String] = [:]

    /// open 要求のコールバック（GozdApp が設定する）
    var onOpenRequest: (@Sendable (String) -> Void)?

    private let lock = NSLock()
    private var started = false

    init(channel: String) {
        self.channel = channel
        self.socketPath = Gozd.socketPath(channel: channel)
        self.claudeSettingsPath = Gozd.claudeSettingsPath(channel: channel)
    }

    // MARK: - 起動

    /// 初回呼び出し時のみソケットサーバーと Claude hooks 設定を初期化する
    func ensureStarted() {
        lock.withLock {
            guard !started else { return }
            started = true
        }
        start()
    }

    /// ソケットサーバーと Claude hooks 設定を初期化する
    private func start() {
        ClaudeHooksGenerator.generate(settingsPath: claudeSettingsPath)

        let socketServer = SocketServer(socketPath: socketPath) { [weak self] message in
            self?.handleSocketMessage(message)
        }
        socketServer.start()
        server = socketServer
    }

    /// アプリ終了時にソケットサーバーを停止する
    func stop() {
        server?.stop()
        server = nil
    }

    // MARK: - シングルインスタンス検出

    /// 既存インスタンスが起動中かどうかを判定する
    ///
    /// ソケットファイルが存在し、接続可能であれば起動中と判定する。
    /// 接続失敗は残骸ソケットを意味する。
    /// Darwin ソケット API を使用し、同期的に接続テストを行う。
    static func isAlreadyRunning(socketPath: String) -> Bool {
        let fm = FileManager.default
        guard fm.fileExists(atPath: socketPath) else { return false }

        guard let fd = connectUnixSocket(path: socketPath) else { return false }
        Darwin.close(fd)
        return true
    }

    /// 既存インスタンスに open メッセージを送信する
    static func sendOpenMessage(socketPath: String, targetPath: String) {
        guard let fd = connectUnixSocket(path: socketPath) else { return }
        defer { Darwin.close(fd) }

        let escaped = targetPath.replacingOccurrences(of: "\"", with: "\\\"")
        let message = "{\"type\":\"open\",\"targetPath\":\"\(escaped)\"}\n"
        guard let data = message.data(using: .utf8) else { return }
        data.withUnsafeBytes { ptr in
            guard let base = ptr.baseAddress else { return }
            _ = Darwin.write(fd, base, ptr.count)
        }
    }

    /// Unix ドメインソケットに同期接続し、ファイルディスクリプタを返す
    private static func connectUnixSocket(path: String) -> Int32? {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)

        let pathBytes = path.utf8CString
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        guard pathBytes.count <= maxLen else {
            Darwin.close(fd)
            return nil
        }

        withUnsafeMutableBytes(of: &addr.sun_path) { dst in
            pathBytes.withUnsafeBufferPointer { src in
                dst.copyBytes(from: UnsafeRawBufferPointer(src))
            }
        }

        let connected = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                Darwin.connect(fd, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }

        guard connected == 0 else {
            Darwin.close(fd)
            return nil
        }

        return fd
    }

    // MARK: - ウィンドウ登録

    /// ウィンドウを登録する
    func registerWindow(
        id: String,
        projectDir: String,
        hookHandler: @escaping @Sendable (HookMessage) -> Void
    ) {
        lock.withLock {
            windowHookHandlers[id] = hookHandler
            projectDirToWindow[projectDir] = id
        }
    }

    /// ウィンドウを登録解除する
    func unregisterWindow(id: String, projectDir: String) {
        lock.withLock {
            windowHookHandlers.removeValue(forKey: id)
            if projectDirToWindow[projectDir] == id {
                projectDirToWindow.removeValue(forKey: projectDir)
            }
            // このウィンドウに属する PTY エントリを削除
            ptyToWindow = ptyToWindow.filter { $0.value != id }
        }
    }

    /// 指定された projectDir に対応するウィンドウが既に存在するか
    func hasWindow(forProjectDir projectDir: String) -> Bool {
        lock.withLock {
            projectDirToWindow[projectDir] != nil
        }
    }

    // MARK: - PTY 登録

    /// PTY をウィンドウに関連付ける
    func registerPTY(ptyId: Int, windowId: String) {
        lock.withLock {
            ptyToWindow[ptyId] = windowId
        }
    }

    /// PTY の関連付けを解除する
    func unregisterPTY(ptyId: Int) {
        lock.withLock { _ = ptyToWindow.removeValue(forKey: ptyId) }
    }

    // MARK: - ソケットメッセージ処理

    private func handleSocketMessage(_ message: GozdMessage) {
        switch message {
        case .hook(let hookMessage):
            print("[gozd] hook: \(hookMessage.event)")
            routeHookMessage(hookMessage)
        case .open(let openMessage):
            print("[gozd] open: \(openMessage.targetPath)")
            onOpenRequest?(openMessage.targetPath)
        }
    }

    /// hook メッセージを ptyId に基づいて適切なウィンドウにルーティングする
    private func routeHookMessage(_ hookMessage: HookMessage) {
        lock.lock()

        // ptyId でウィンドウを特定
        if let ptyId = hookMessage.payload.ptyId,
           let windowId = ptyToWindow[ptyId],
           let handler = windowHookHandlers[windowId]
        {
            lock.unlock()
            handler(hookMessage)
            return
        }

        // ptyId が見つからない場合は全ウィンドウにブロードキャスト
        let allHandlers = Array(windowHookHandlers.values)
        lock.unlock()

        for handler in allHandlers {
            handler(hookMessage)
        }
    }
}


