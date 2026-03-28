import AppKit
import SwiftUI

@main
struct GozdApp: App {
    @NSApplicationDelegateAdaptor private var appDelegate: AppDelegate

    /// アプリ全体のコーディネーター（SocketServer, hook ルーティング等）
    private let coordinator: AppCoordinator

    /// 起動引数またはカレントディレクトリからプロジェクトパスを取得
    private let initialPath: String

    var body: some Scene {
        // メインウィンドウ（Window は起動時に必ず 1 枚作成される）
        // ただしパス引数があると AppKit がファイルオープン要求と解釈し、
        // ウィンドウ自動生成をスキップする場合がある。
        // その場合は AppDelegate.applicationDidFinishLaunching で補完する。
        Window("Gozd", id: "main") {
            ProjectWindowContainer(
                path: initialPath,
                coordinator: coordinator
            )
            .task {
                coordinator.ensureStarted()
            }
        }

        // 追加ウィンドウ用（OpenMessage 受信時に openWindow(id:value:) で作成）
        WindowGroup(id: "project", for: String.self) { $projectPath in
            if let projectPath {
                ProjectWindowContainer(
                    path: projectPath,
                    coordinator: coordinator
                )
            }
        }
    }

    init() {
        let args = CommandLine.arguments
        let path = args.count > 1 ? args[1] : FileManager.default.currentDirectoryPath
        let url = URL(fileURLWithPath: path, relativeTo: URL(fileURLWithPath: FileManager.default.currentDirectoryPath))
        initialPath = url.standardized.path

        let coord = AppCoordinator(channel: "dev")

        // シングルインスタンス制御: 既存インスタンスが起動中なら open メッセージを送信して終了
        if AppCoordinator.isAlreadyRunning(socketPath: coord.socketPath) {
            AppCoordinator.sendOpenMessage(socketPath: coord.socketPath, targetPath: initialPath)
            exit(0)
        }

        coordinator = coord
    }
}

/// openWindow を AppCoordinator に橋渡しするラッパービュー
struct ProjectWindowContainer: View {
    let path: String
    let coordinator: AppCoordinator
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        ContentView(initialPath: path, coordinator: coordinator)
            .onAppear {
                NSApp.activate(ignoringOtherApps: true)

                coordinator.onOpenRequest = { targetPath in
                    Task { @MainActor in
                        handleOpenRequest(targetPath)
                    }
                }
            }
    }

    @MainActor
    private func handleOpenRequest(_ targetPath: String) {
        let projectDir = resolveProjectDir(from: targetPath)

        if let existingWindow = findNSWindow(forProjectDir: projectDir) {
            existingWindow.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        openWindow(id: "project", value: targetPath)
        NSApp.activate(ignoringOtherApps: true)
    }

    @MainActor
    private func findNSWindow(forProjectDir projectDir: String) -> NSWindow? {
        guard coordinator.hasWindow(forProjectDir: projectDir) else { return nil }
        let repoName = (projectDir as NSString).lastPathComponent
        return NSApp.windows.first { window in
            window.title.hasPrefix(repoName) && window.isVisible
        }
    }
}

/// AppDelegate: ウィンドウ生成の補完とファイルオープン要求の抑制
///
/// macOS はコマンドライン引数に実在するパスがあると application(_:open:) を呼び、
/// Window scene の自動生成をスキップする。CodeEdit と同様のパターンで、
/// applicationDidFinishLaunching でウィンドウがない場合に明示的に開く。
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, ObservableObject {
    @Environment(\.openWindow) var openWindow

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)

        // パス引数による application(_:open:) でウィンドウ生成がスキップされた場合の補完
        DispatchQueue.main.async {
            let hasVisibleWindow = NSApp.windows.contains { $0.isVisible }
            if !hasVisibleWindow {
                self.openWindow(id: "main")
                NSApp.activate(ignoringOtherApps: true)
            }
        }
    }

    /// コマンドライン引数のパスを AppKit のファイルオープン要求として処理しない
    ///
    /// パスは GozdApp.init() で CommandLine.arguments から直接取得済み。
    /// この実装がないと AppKit のデフォルト処理が走り、
    /// 「ファイルを開けません」ダイアログが出る場合がある。
    func application(_ application: NSApplication, open urls: [URL]) {
        // 何もしない
    }
}
