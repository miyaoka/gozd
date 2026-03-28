import Darwin
import Dispatch
import Foundation

/// PTY プロセスのライフサイクルを管理する
///
/// SwiftTerm の Pty.swift / LocalProcess.swift のパターンに倣い、
/// forkpty + DispatchIO + DispatchSourceProcess で構成する。
final class PTYManager: @unchecked Sendable {
    struct Callbacks: Sendable {
        let onData: @Sendable (Int, ArraySlice<UInt8>) -> Void
        let onExit: @Sendable (Int, Int32) -> Void
    }

    private struct PTYEntry {
        let masterFd: Int32
        let pid: pid_t
        let io: DispatchIO
        let processMonitor: DispatchSourceProcess
        var running: Bool
    }

    private var ptys: [Int: PTYEntry] = [:]
    private var nextId = 1
    private let callbacks: Callbacks
    /// コールバック配信用キュー
    private let dispatchQueue = DispatchQueue(label: "gozd.pty.dispatch")
    /// I/O 読み取り用キュー
    private let readQueue = DispatchQueue(label: "gozd.pty.read", qos: .userInteractive)
    /// 状態操作用キュー
    private let stateQueue = DispatchQueue(label: "gozd.pty.state")

    init(callbacks: Callbacks) {
        self.callbacks = callbacks
    }

    /// PTY を生成し、シェルプロセスを起動する
    ///
    /// 環境変数に `GOZD_PTY_ID` を自動注入する。
    /// hooks がどの PTY から発火したか特定するために使用する。
    func spawn(cwd: String, cols: Int, rows: Int, env: [String: String]) -> Int {
        var id = 0
        stateQueue.sync {
            id = nextId
            nextId += 1
        }

        // GOZD_PTY_ID を注入してから "KEY=VALUE" 形式に変換
        var envWithPtyId = env
        envWithPtyId["GOZD_PTY_ID"] = String(id)
        let envStrings = envWithPtyId.map { "\($0.key)=\($0.value)" }
        let shell = env["SHELL"] ?? "/bin/zsh"
        let args = [shell, "-l"]

        var winSize = winsize(
            ws_row: UInt16(rows),
            ws_col: UInt16(cols),
            ws_xpixel: 0,
            ws_ypixel: 0
        )

        guard let result = PseudoTerminalHelpers.fork(
            andExec: shell,
            args: args,
            env: envStrings,
            currentDirectory: cwd,
            desiredWindowSize: &winSize
        ) else {
            return -1
        }

        let (pid, masterFd) = result

        // DispatchSource.makeProcessSource で PID の終了を監視
        let processMonitor = DispatchSource.makeProcessSource(
            identifier: pid,
            eventMask: .exit,
            queue: dispatchQueue
        )

        let capturedId = id

        processMonitor.setEventHandler { [weak self] in
            self?.processTerminated(id: capturedId)
        }
        processMonitor.activate()

        // DispatchIO で master fd の読み書きを管理
        // cleanupHandler で FD をクローズ（EV_VANISHED クラッシュ防止）
        let fdToClose = masterFd
        let io = DispatchIO(
            type: .stream,
            fileDescriptor: masterFd,
            queue: dispatchQueue,
            cleanupHandler: { _ in
                close(fdToClose)
            }
        )
        io.setLimit(lowWater: 1)

        let entry = PTYEntry(
            masterFd: masterFd,
            pid: pid,
            io: io,
            processMonitor: processMonitor,
            running: true
        )

        stateQueue.sync {
            ptys[id] = entry
        }

        // 読み取り開始
        scheduleRead(id: capturedId, io: io)

        return id
    }

    /// PTY にデータを書き込む
    func write(id: Int, data: String) {
        var io: DispatchIO?
        stateQueue.sync {
            guard let entry = ptys[id], entry.running else { return }
            io = entry.io
        }
        guard let io else { return }

        guard let bytes = data.data(using: .utf8) else { return }
        bytes.withUnsafeBytes { buffer in
            guard let ptr = buffer.baseAddress else { return }
            let dispatchData = DispatchData(
                bytes: UnsafeRawBufferPointer(start: ptr, count: buffer.count))
            // entry.io 経由で書き込み（FD ライフサイクルを DispatchIO に統一）
            io.write(
                offset: 0,
                data: dispatchData,
                queue: dispatchQueue,
                ioHandler: { _, _, _ in }
            )
        }
    }

    /// PTY のウィンドウサイズを変更する
    func resize(id: Int, cols: Int, rows: Int) {
        var masterFd: Int32?
        stateQueue.sync {
            guard let entry = ptys[id], entry.running else { return }
            masterFd = entry.masterFd
        }
        guard let fd = masterFd else { return }

        var winSize = winsize(
            ws_row: UInt16(rows),
            ws_col: UInt16(cols),
            ws_xpixel: 0,
            ws_ypixel: 0
        )
        _ = ioctl(fd, TIOCSWINSZ, &winSize)
    }

    /// PTY プロセスを終了する
    func kill(id: Int) {
        var entry: PTYEntry?
        stateQueue.sync {
            entry = ptys[id]
        }
        guard let entry, entry.running else { return }

        // DispatchIO を先にクローズ（cleanupHandler が FD をクローズする）
        entry.io.close()

        if entry.pid != 0 {
            Darwin.kill(entry.pid, SIGHUP)
        }

        stateQueue.sync {
            ptys[id]?.running = false
        }
    }

    // MARK: - Private

    private func scheduleRead(id: Int, io: DispatchIO) {
        let capturedCallbacks = callbacks
        io.read(offset: 0, length: 128 * 1024, queue: readQueue) {
            [weak self] done, data, errno in

            guard let data, data.count > 0 else {
                if data?.count == 0 {
                    // PTY EOF
                    self?.stateQueue.sync {
                        // processMonitor は生かす（exit イベントで processTerminated が呼ばれる）
                        self?.ptys[id]?.running = false
                    }
                }
                return
            }

            // DispatchData → UInt8 配列
            var bytes = [UInt8](repeating: 0, count: data.count)
            bytes.withUnsafeMutableBufferPointer { ptr in
                _ = data.copyBytes(to: ptr)
            }

            // running チェック後にコールバック
            var isRunning = false
            self?.stateQueue.sync {
                isRunning = self?.ptys[id]?.running ?? false
            }
            if isRunning {
                capturedCallbacks.onData(id, bytes[...])
            }

            // 次の読み取りをスケジュール
            if isRunning {
                self?.scheduleRead(id: id, io: io)
            }
        }
    }

    private func processTerminated(id: Int) {
        var entry: PTYEntry?
        stateQueue.sync {
            entry = ptys[id]
            ptys[id]?.running = false
        }
        guard let entry else { return }

        // waitpid（WNOHANG でノンブロッキング）
        // DispatchSourceProcess の .exit イベント後なので通常は即座に reap できる
        var status: Int32 = 0
        let waited = waitpid(entry.pid, &status, WNOHANG)

        // C マクロの手動展開
        let exitCode: Int32
        if waited == entry.pid {
            let exited = (status & 0x7F) == 0
            if exited {
                exitCode = Int32((status >> 8) & 0xFF)
            } else {
                let signal = status & 0x7F
                exitCode = 128 + signal
            }
        } else {
            // reap 失敗（既に回収済み等）
            exitCode = -1
        }

        // DispatchIO をクローズ
        entry.io.close()
        entry.processMonitor.cancel()

        _ = stateQueue.sync {
            ptys.removeValue(forKey: id)
        }

        // コールバックはロック外
        callbacks.onExit(id, exitCode)
    }
}

// MARK: - forkpty ヘルパー（SwiftTerm の Pty.swift パターン）

/// fork 前に C 文字列を確保し、子プロセスでは Swift ランタイムに触れない
private enum PseudoTerminalHelpers {

    /// NULL 終端の C 文字列ポインタ配列
    private struct CStringArray {
        let base: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>
        let count: Int
    }

    private static func allocateCStringArray(
        _ strings: [String]
    ) -> CStringArray? {
        let base = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>
            .allocate(capacity: strings.count + 1)
        var initializedCount = 0

        for (index, string) in strings.enumerated() {
            guard let duplicated = strdup(string) else {
                for cleanupIndex in 0 ..< initializedCount {
                    free(base[cleanupIndex])
                }
                base.deallocate()
                return nil
            }
            base[index] = duplicated
            initializedCount += 1
        }

        base[strings.count] = nil
        return CStringArray(base: base, count: strings.count)
    }

    private static func freeCStringArray(_ array: CStringArray) {
        for index in 0 ..< array.count {
            free(array.base[index])
        }
        array.base.deallocate()
    }

    /// forkpty でプロセスを生成する
    ///
    /// fork 前に全ての文字列を C 形式に変換し、
    /// 子プロセスでは libc 関数と生ポインタのみ使用する。
    static func fork(
        andExec executable: String,
        args: [String],
        env: [String],
        currentDirectory: String,
        desiredWindowSize: inout winsize
    ) -> (pid: pid_t, masterFd: Int32)? {
        guard let cArgs = allocateCStringArray(args) else {
            return nil
        }
        guard let cEnv = allocateCStringArray(env) else {
            freeCStringArray(cArgs)
            return nil
        }
        guard let cExecutable = strdup(executable) else {
            freeCStringArray(cEnv)
            freeCStringArray(cArgs)
            return nil
        }
        guard let cCwd = strdup(currentDirectory) else {
            free(cExecutable)
            freeCStringArray(cEnv)
            freeCStringArray(cArgs)
            return nil
        }

        defer {
            freeCStringArray(cArgs)
            freeCStringArray(cEnv)
            free(cExecutable)
            free(cCwd)
        }

        var master: Int32 = 0
        let pid = forkpty(&master, nil, nil, &desiredWindowSize)

        if pid < 0 {
            return nil
        }
        if pid == 0 {
            // 子プロセス: libc 関数と生ポインタのみ使用
            // Swift ランタイム（ARC, Array, Dictionary 等）には一切触れない
            chdir(cCwd)
            execve(cExecutable, cArgs.base, cEnv.base)
            _exit(127)
        }

        return (pid, master)
    }
}
