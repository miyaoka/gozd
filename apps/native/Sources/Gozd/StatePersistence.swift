import CommonCrypto
import Foundation

// MARK: - 設定ディレクトリ

/// アプリの設定・データ保存のベースディレクトリ
private let configDir: String = {
    let home = NSHomeDirectory()
    return (home as NSString).appendingPathComponent(".config/gozd")
}()

/// 設定ディレクトリを作成する（存在しなければ）
private func ensureConfigDir() {
    let fm = FileManager.default
    if !fm.fileExists(atPath: configDir) {
        try? fm.createDirectory(atPath: configDir, withIntermediateDirectories: true)
    }
}

// MARK: - ProjectKey

/// プロジェクトディレクトリから NAME_MAX 安全なディレクトリ名を生成する
///
/// realpath で symlink を解決し、SHA-256 ハッシュで一意性を保証する。
/// 形式: `<repoName>-<hash>`（例: `gozd-a1b2c3d4e5f6`）
enum ProjectKey {
    private static let hashLength = 12
    /// APFS / ext4 の NAME_MAX（255 bytes）
    private static let nameMaxBytes = 255
    private static let suffixBytes = 1 + hashLength  // "-" + hash
    private static let maxNameBytes = nameMaxBytes - suffixBytes

    /// プロジェクトディレクトリからキーを生成する
    static func generate(from projectDir: String) -> String {
        let realPath = PathValidator.resolveRealPath(projectDir) ?? projectDir
        let hash = sha256Hex(realPath).prefix(hashLength)
        let name = truncateToBytes((realPath as NSString).lastPathComponent, maxBytes: maxNameBytes)
        return "\(name)-\(hash)"
    }

    /// UTF-8 バイト数が上限に収まるよう文字列を切り詰める
    private static func truncateToBytes(_ str: String, maxBytes: Int) -> String {
        guard let data = str.data(using: .utf8), data.count > maxBytes else { return str }
        var byteLen = 0
        var endIndex = str.startIndex
        for char in str {
            let charBytes = String(char).utf8.count
            if byteLen + charBytes > maxBytes { break }
            byteLen += charBytes
            endIndex = str.index(after: endIndex)
        }
        return String(str[str.startIndex..<endIndex])
    }

    /// SHA-256 ハッシュの hex 文字列を返す
    private static func sha256Hex(_ string: String) -> String {
        let data = Data(string.utf8)
        var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        data.withUnsafeBytes { buffer in
            _ = CC_SHA256(buffer.baseAddress, CC_LONG(data.count), &hash)
        }
        return hash.map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - AppState（ウィンドウ状態）

/// ウィンドウのフレーム情報
struct WindowFrame: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

/// ウィンドウの状態
struct WindowState: Codable {
    /// プロジェクトディレクトリ（git repo の場合は main worktree のルート）
    let dir: String
    /// 最後にアクティブだった worktree ディレクトリ
    let activeDir: String
    /// ウィンドウのフレーム（位置・サイズ）
    let frame: WindowFrame
}

/// アプリ全体の状態
struct AppState: Codable {
    var windows: [WindowState]
}

enum AppStatePersistence {
    private static let stateFile = (configDir as NSString).appendingPathComponent("app-state.json")

    private static let defaultFrame = WindowFrame(x: 100, y: 100, width: 1200, height: 800)

    /// 保存済みの状態を読み込む
    static func load() -> AppState {
        guard let data = FileManager.default.contents(atPath: stateFile),
            let state = try? JSONDecoder().decode(AppState.self, from: data)
        else {
            return AppState(windows: [])
        }
        return state
    }

    /// snapshot を受け取って即時保存する（アプリ終了時の唯一のコミット点）
    static func saveSnapshot(windows: [WindowState]) {
        ensureConfigDir()
        let state = AppState(windows: windows)
        guard let data = try? JSONEncoder.prettyPrinted.encode(state) else {
            print("[app-state] save failed: encode error")
            return
        }
        do {
            try data.write(to: URL(fileURLWithPath: stateFile))
        } catch {
            print("[app-state] save failed: \(error.localizedDescription)")
        }
    }

    /// デフォルトのフレーム値
    static func getDefaultFrame() -> WindowFrame { defaultFrame }
}

// MARK: - Config（グローバル設定）

/// アプリ設定
struct AppConfig: Codable {
    var terminalFontFamily: String?
    var terminalFontSize: Int?
    var terminalTheme: String?
    var previewFontFamily: String?
    var previewFontSize: Int?
    var voicevoxEnabled: Bool?
    var voicevoxSpeedScale: Double?
    var voicevoxVolumeScale: Double?

    private enum CodingKeys: String, CodingKey {
        case terminalFontFamily = "terminal.fontFamily"
        case terminalFontSize = "terminal.fontSize"
        case terminalTheme = "terminal.theme"
        case previewFontFamily = "preview.fontFamily"
        case previewFontSize = "preview.fontSize"
        case voicevoxEnabled = "voicevox.enabled"
        case voicevoxSpeedScale = "voicevox.speedScale"
        case voicevoxVolumeScale = "voicevox.volumeScale"
    }
}

enum ConfigPersistence {
    private static let configFile = (configDir as NSString).appendingPathComponent("config.json")

    /// 設定を読み込む
    static func load() -> AppConfig {
        guard let data = FileManager.default.contents(atPath: configFile),
            let config = try? JSONDecoder().decode(AppConfig.self, from: data)
        else {
            return AppConfig()
        }
        return config
    }

    /// 設定を保存する（read-modify-write）
    static func save(patch: AppConfig) {
        ensureConfigDir()
        var current = load()
        // パッチの非 nil フィールドをマージ
        if let v = patch.terminalFontFamily { current.terminalFontFamily = v }
        if let v = patch.terminalFontSize { current.terminalFontSize = v }
        if let v = patch.terminalTheme { current.terminalTheme = v }
        if let v = patch.previewFontFamily { current.previewFontFamily = v }
        if let v = patch.previewFontSize { current.previewFontSize = v }
        if let v = patch.voicevoxEnabled { current.voicevoxEnabled = v }
        if let v = patch.voicevoxSpeedScale { current.voicevoxSpeedScale = v }
        if let v = patch.voicevoxVolumeScale { current.voicevoxVolumeScale = v }

        guard let data = try? JSONEncoder.prettyPrinted.encode(current) else { return }
        try? data.write(to: URL(fileURLWithPath: configFile))
    }
}

// MARK: - Task（プロジェクト固有タスク）

/// タスク
struct TaskItem: Codable {
    let id: String
    var body: String
    var worktreeDir: String?
    var prNumber: Int?
    var issueNumber: Int?
    let createdAt: String
}

enum TaskPersistence {
    private static let projectsDir = (configDir as NSString).appendingPathComponent("projects")
    private static let tasksFileName = "tasks.json"

    private static func getProjectDir(_ projectDir: String) -> String {
        (projectsDir as NSString).appendingPathComponent(ProjectKey.generate(from: projectDir))
    }

    private static func getTasksPath(_ projectDir: String) -> String {
        (getProjectDir(projectDir) as NSString).appendingPathComponent(tasksFileName)
    }

    private static func ensureProjectDir(_ projectDir: String) {
        let dir = getProjectDir(projectDir)
        let fm = FileManager.default
        if !fm.fileExists(atPath: dir) {
            try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        }
    }

    /// Task 一覧を読み込む
    static func loadTasks(projectDir: String) -> [TaskItem] {
        let path = getTasksPath(projectDir)
        guard let data = FileManager.default.contents(atPath: path),
            let tasks = try? JSONDecoder().decode([TaskItem].self, from: data)
        else {
            return []
        }
        return tasks
    }

    /// Task 一覧を保存する
    private static func saveTasks(projectDir: String, tasks: [TaskItem]) {
        ensureProjectDir(projectDir)
        guard let data = try? JSONEncoder.prettyPrinted.encode(tasks) else { return }
        try? data.write(to: URL(fileURLWithPath: getTasksPath(projectDir)))
    }

    /// Task を追加する
    static func addTask(
        projectDir: String,
        body: String,
        worktreeDir: String? = nil,
        prNumber: Int? = nil,
        issueNumber: Int? = nil
    ) throws -> TaskItem {
        var tasks = loadTasks(projectDir: projectDir)
        if let worktreeDir, tasks.contains(where: { $0.worktreeDir == worktreeDir }) {
            throw TaskError.worktreeAlreadyLinked(worktreeDir)
        }
        let task = TaskItem(
            id: UUID().uuidString,
            body: body,
            worktreeDir: worktreeDir,
            prNumber: prNumber,
            issueNumber: issueNumber,
            createdAt: ISO8601DateFormatter().string(from: Date())
        )
        tasks.append(task)
        saveTasks(projectDir: projectDir, tasks: tasks)
        return task
    }

    /// Task の body を更新する
    static func updateTask(projectDir: String, id: String, body: String) throws -> TaskItem {
        var tasks = loadTasks(projectDir: projectDir)
        guard let index = tasks.firstIndex(where: { $0.id == id }) else {
            throw TaskError.notFound(id)
        }
        tasks[index].body = body
        saveTasks(projectDir: projectDir, tasks: tasks)
        return tasks[index]
    }

    /// Task を削除する
    static func removeTask(projectDir: String, id: String) {
        let tasks = loadTasks(projectDir: projectDir)
        let filtered = tasks.filter { $0.id != id }
        guard filtered.count != tasks.count else { return }
        saveTasks(projectDir: projectDir, tasks: filtered)
    }

    /// worktreeDir で Task を検索する
    static func findByWorktreeDir(projectDir: String, worktreeDir: String) -> TaskItem? {
        loadTasks(projectDir: projectDir).first { $0.worktreeDir == worktreeDir }
    }

    /// worktree に Task を紐づける
    static func linkToWorktree(projectDir: String, id: String, worktreeDir: String) throws -> TaskItem {
        var tasks = loadTasks(projectDir: projectDir)
        guard !tasks.contains(where: { $0.worktreeDir == worktreeDir }) else {
            throw TaskError.worktreeAlreadyLinked(worktreeDir)
        }
        guard let index = tasks.firstIndex(where: { $0.id == id }) else {
            throw TaskError.notFound(id)
        }
        guard tasks[index].worktreeDir == nil else {
            throw TaskError.alreadyLinked(tasks[index].worktreeDir ?? "")
        }
        tasks[index].worktreeDir = worktreeDir
        saveTasks(projectDir: projectDir, tasks: tasks)
        return tasks[index]
    }

    /// stale な Task を削除する
    static func cleanupStale(projectDir: String, validWorktreePaths: [String]) {
        let tasks = loadTasks(projectDir: projectDir)
        let validSet = Set(validWorktreePaths)
        let cleaned = tasks.filter { task in
            guard let wtDir = task.worktreeDir else { return true }
            return validSet.contains(wtDir)
        }
        guard cleaned.count != tasks.count else { return }
        saveTasks(projectDir: projectDir, tasks: cleaned)
    }
}

enum TaskError: Error, LocalizedError {
    case notFound(String)
    case worktreeAlreadyLinked(String)
    case alreadyLinked(String)

    var errorDescription: String? {
        switch self {
        case .notFound(let id): "Task not found: \(id)"
        case .worktreeAlreadyLinked(let dir): "worktree already has a linked Task: \(dir)"
        case .alreadyLinked(let dir): "Task already linked to a worktree: \(dir)"
        }
    }
}

// MARK: - ProjectConfig（プロジェクト固有設定）

/// プロジェクト固有の設定
struct ProjectConfig: Codable {
    /// worktree 作成時にメインリポジトリからシンボリックリンクする対象パス
    var worktreeSymlinks: [String]?
}

enum ProjectConfigPersistence {
    private static let projectsDir = (configDir as NSString).appendingPathComponent("projects")
    private static let configFileName = "config.json"

    private static func getProjectDir(_ projectDir: String) -> String {
        (projectsDir as NSString).appendingPathComponent(ProjectKey.generate(from: projectDir))
    }

    private static func getConfigPath(_ projectDir: String) -> String {
        (getProjectDir(projectDir) as NSString).appendingPathComponent(configFileName)
    }

    private static func ensureProjectDir(_ projectDir: String) {
        let dir = getProjectDir(projectDir)
        let fm = FileManager.default
        if !fm.fileExists(atPath: dir) {
            try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        }
    }

    /// プロジェクト設定を読み込む（ファイル未作成や不正な場合は空設定）
    static func load(projectDir: String) -> ProjectConfig {
        let path = getConfigPath(projectDir)
        guard let data = FileManager.default.contents(atPath: path),
            let config = try? JSONDecoder().decode(ProjectConfig.self, from: data)
        else {
            return ProjectConfig()
        }
        return config
    }

    /// プロジェクト設定を保存する（read-modify-write）
    static func save(projectDir: String, patch: ProjectConfig) {
        ensureProjectDir(projectDir)
        var current = load(projectDir: projectDir)
        if let v = patch.worktreeSymlinks { current.worktreeSymlinks = v }
        guard let data = try? JSONEncoder.prettyPrinted.encode(current) else { return }
        try? data.write(to: URL(fileURLWithPath: getConfigPath(projectDir)))
    }
}

// MARK: - JSONEncoder 拡張

extension JSONEncoder {
    /// Pretty-printed + sorted keys の JSONEncoder
    static var prettyPrinted: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }
}
