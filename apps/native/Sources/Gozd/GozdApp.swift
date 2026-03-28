import AppKit
import SwiftUI

@main
struct GozdApp: App {
    @NSApplicationDelegateAdaptor private var appDelegate: AppDelegate

    /// 起動引数またはカレントディレクトリからプロジェクトパスを取得
    private let initialPath: String = {
        let args = CommandLine.arguments
        let path = args.count > 1 ? args[1] : FileManager.default.currentDirectoryPath
        let url = URL(fileURLWithPath: path, relativeTo: URL(fileURLWithPath: FileManager.default.currentDirectoryPath))
        return url.standardized.path
    }()

    var body: some Scene {
        WindowGroup {
            ContentView(initialPath: initialPath)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // swift run（非 .app バンドル）で起動した場合にウィンドウを前面に出す
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
}
