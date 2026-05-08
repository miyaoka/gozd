# Swift 全面書き直し 作業用メモ

Electrobun / Bun を完全撤廃し、Swift（macOS 26 Tahoe 以降）で gozd を再実装するための設計用メモ。実装は未着手。

> [!NOTE]
> 検証用スパイクを別 private repo（[`miyaoka/gozd-spike`](https://github.com/miyaoka/gozd-spike)）で実施し、本ドキュメント末尾の「スパイクで実証された事実」に検証済み事項として記録した

> [!CAUTION]
> **これは漸進的移行ではない。このブランチ一発で全部書き換える。**
>
> - 旧スタック（`apps/desktop/` / `apps/cli/` / `packages/rpc/`）を「動く状態で残す」義務はない。作業ブランチでは途中状態で動かなくなってよい
> - 動く版は `main` ブランチに常にある。git がその役割を担う。コードベース内に「並行構築」「比較検証用の並行ディレクトリ」「フィーチャーフラグ」「ブリッジ層」のような漸進移行の道具立てを作らない
> - View 以外（RPC・composable・store・shared・CLI・メインプロセス）は全部新規作成。残せるのは Vue SFC の `<template>` / `<style>` / 純粋な表示ロジックのみ
> - Phase は構築順序であって、旧と新の共存時間軸ではない
> - 完成したらこのブランチを `main` にマージ。同時に旧コードは消える

## 方針（決定済み）

- ランタイムは Swift のみ。Electrobun / Bun 依存をゼロにする
- アプリ UI は **丸ごと WebView**。SwiftUI ネイティブのサイドバーやメインペインは作らない
- **View 層（Vue SFC のテンプレート / スタイル / 純粋な表示ロジック）のみ流用する**。RPC スキーマ、composable、store、`shared/`、`packages/`、CLI、メインプロセスはすべて新規作成
- シングルウィンドウ + マルチリポジトリ（[issue #310](https://github.com/miyaoka/gozd/issues/310) の方針と整合）
- 対象 OS: macOS 26 Tahoe 以降。Xcode 26、Swift 6.2+
- Bundle ID: `io.github.miyaoka.gozd`（独自ドメイン未所有のため `io.github.<username>` 形式を採用、Sniffnet / Ghostwriter / Endless Sky / DOSBox Staging 等の OSS macOS アプリで実績あり）
- Swift module / executable 名: `Gozd`（PascalCase）
- CLI（`gozd open <path>` 等）はソケット互換のみ保証して残す（Swift で新規実装）
- 完成と同時に `apps/desktop/` / `apps/cli/`（旧 Bun 版）/ `packages/rpc/`（旧 Electrobun RPC スキーマ）を削除

### 型共有戦略: `.proto` SSOT

TypeScript（renderer）と Swift（native）で RPC 型を共有する手段として、2026 年 5 月時点で実用に耐えるのは Protocol Buffers のみ。`.proto` を SSOT とし、TS / Swift 両方のコードを生成する。

調査結果（2026-05 時点）:

| 候補                          | 状況                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| quicktype                     | discriminated union 対応が壊れたまま長期放置（[Issue #493](https://github.com/glideapps/quicktype/issues/493) Open） |
| typeshare                     | Rust が SSOT 前提。TS を SSOT にできない                                                                             |
| Apollo iOS（GraphQL）         | 2024-04 で停滞                                                                                                       |
| Smithy / TypeSpec             | Swift 公式 codegen なし                                                                                              |
| tRPC / oRPC                   | Swift 公式クライアント生成なし                                                                                       |
| JSON Typedef                  | 2021 から放置                                                                                                        |
| **ts-proto + swift-protobuf** | **両方 2026-04〜05 に現役リリース**                                                                                  |

採用するツール:

- **ts-proto** v2.11.8（2026-05-07） — `.proto` → TS 型生成
- **swift-protobuf** v1.37.0（2026-04-20） — `.proto` → Swift Codable 生成
- **buf CLI** v1.69.0（2026-04-29） — `.proto` の lint / break-detect / 生成パイプライン管理

> [!IMPORTANT]
> **Connect-Swift（buf 製の RPC フレームワーク）は使わない**。v1.2.2（2025-03-30）で停滞しているため、依存に組み込むとリスクになる。
>
> gRPC transport も使わない。型定義（codegen）部分だけ Protobuf を使い、トランスポートは `gozd-rpc://` URLSchemeHandler + Unix Socket（NDJSON）で自前実装する。Protobuf の `oneof` を discriminated union として使うのが目的。

配置:

```text
packages/
├── proto/                     # SSOT。.proto と buf 設定のみ
│   ├── buf.yaml
│   ├── buf.gen.yaml
│   └── gozd/v1/*.proto
├── proto-ts/                  # ts-proto 生成物。npm パッケージ（@gozd/proto）として renderer が import
│   ├── package.json
│   └── src/gozd/v1/*.ts
└── proto-swift/               # swift-protobuf 生成物。SPM パッケージとして apps/native が import
    ├── Package.swift
    └── Sources/GozdProto/gozd/v1/*.pb.swift
```

**生成物は git に commit する**。`buf.gen.yaml` でプラグインバージョンを pin して再現性を確保。Connect 公式サンプル（`connectrpc/examples-es`）も同じ運用。

### Liquid Glass の扱い

ウィンドウクロームと標準ツールバー / メニューが Xcode 26 ビルドで自動的に Liquid Glass を受ける範囲しか使わない。WebView 内には適用されない（renderer は Vue / Tailwind の従来描画）。

### ハイブリッドの定義（再確認）

「ハイブリッド」は **Swift プロセス + WebView コンテンツ** の意味。Electron との並存は意図しない。

## 確認済み公式 API（出典: developer.apple.com、2026-05 時点）

以下は Chrome で公式ドキュメントを直接読んで確認した内容のみ記載する。WWDC25 セッショントランスクリプト等の二次情報は採用しない。

### WebKit for SwiftUI

`import WebKit` で利用。macOS 26.0+ / iOS 26.0+ / iPadOS 26.0+ / Mac Catalyst 26.0+ / visionOS 26.0+。

#### `WebView`（struct, View, Sendable, @MainActor）

- イニシャライザ: `init(WebPage)` / `init(url: URL?)`
- ScrollView 相当の挙動（リンククリックで内部遷移、`scrollBounceBehavior` 等が効く）
- 1 つの `WebPage` は同時に 1 つの `WebView` にしかバインドできない
- 主な modifier:
  - 操作系: `webViewBackForwardNavigationGestures`, `webViewMagnificationGestures`, `webViewLinkPreviews`, `webViewTextSelection`, `webViewElementFullscreenBehavior`, `webViewContextMenu`, `webViewContentBackground`
  - スクロール系: `webViewScrollPosition`, `webViewScrollInputBehavior`, `webViewOnScrollGeometryChange`

#### `WebPage`（@MainActor final class, Observable, Sendable, Transferable）

- イニシャライザは 4 種。最低限 `WebPage.Configuration` を渡す。`navigationDecider`, `dialogPresenter` を任意で渡せる
- 読み込み API は **すべて** `some AsyncSequence<WebPage.NavigationEvent, any Error>` を返す:
  - `load(URLRequest)`
  - `load(URL?)`
  - `load(html: String, baseURL: URL)`
  - `load(Data, mimeType:characterEncoding:baseURL:)`
  - `load(simulatedRequest:responseHTML:)`
  - `load(simulatedRequest:response:responseData:)`
  - `load(BackForwardList.Item)`
- 観測可能プロパティ（Observable で SwiftUI 自動更新）:
  - `title: String`
  - `url: URL?`
  - `isLoading: Bool`
  - `estimatedProgress: Double`
  - `themeColor: Color?`
  - `mediaType: CSSMediaType?`
  - `serverTrust: SecTrust?`
  - `hasOnlySecureContent: Bool`
  - `isInspectable: Bool`
  - `customUserAgent: String?`
- 全ナビゲーション観測: `var navigations: some AsyncSequence<NavigationEvent, Error>`
- JavaScript 呼び出し:

```swift
func callJavaScript(
    _ functionBody: String,
    arguments: [String: Any],
    in: WebPage.FrameInfo?,
    contentWorld: WKContentWorld?
) async throws -> sending Any?
```

- リロード / 停止: `reload(fromOrigin:)` / `stopLoading()`
- メディア制御 / PDF・Web Archive エクスポート (`exported(as:)`) もある

#### `WebPage.Configuration`（@MainActor struct, Sendable）

カスタムスキーム登録の中核。

- `var urlSchemeHandlers: [URLScheme: any URLSchemeHandler]` ← **RPC ブリッジの登録ポイント**
- `defaultNavigationPreferences`, `loadsSubresources`, `applicationNameForUserAgent`, `websiteDataStore`, `userContentController`, `webExtensionController`, `dataDetectorTypes`, `mediaPlaybackBehavior`, `limitsNavigationsToAppBoundDomains`, `upgradeKnownHostsToHTTPS`, `deviceSensorAuthorization` ほか

#### `URLSchemeHandler`（protocol）

```swift
protocol URLSchemeHandler {
    associatedtype TaskSequence: AsyncSequence
    func reply(for: URLRequest) -> Self.TaskSequence
}
```

> [!IMPORTANT]
> 公式ドキュメント上のメソッド名は **`reply(for:)`**。WWDC25 セッショントランスクリプトに `task(for:)` という記述があるが、それは記事側の誤り。

WebKit がリソース不要と判断した場合、handler の Task は自動キャンセルされる。

#### `URLScheme`（struct, Equatable, Hashable, Sendable）

- `init?(String)` — WebKit 既知のスキーム（`https`, `file`, `about` 等）を渡すと `nil`
- 制約: 大小区別あり、ASCII 英字始まり、許可文字は `[A-Za-z0-9+\-.]`

#### `URLSchemeTaskResult`（enum, Sendable）

- `case data(Data)` — 部分または全データ
- `case response(URLResponse)` — **MIME type を含むこと**

#### `WebPage.NavigationEvent`（enum, Equatable, Hashable, Sendable）

4 ケースのみ:

- `.startedProvisionalNavigation`
- `.receivedServerRedirect`
- `.committed`
- `.finished`

#### `WebPage.NavigationDeciding`（protocol、すべてに既定実装あり）

- `decidePolicy(for: NavigationAction, preferences: inout NavigationPreferences) async -> WKNavigationActionPolicy`
- `decidePolicy(for: NavigationResponse) async -> WKNavigationResponsePolicy`
- `decideAuthenticationChallengeDisposition(for: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?)`

### SwiftUI シーン（macOS）

#### `Window`（macOS 13.0+）

```swift
@main struct Gozd: App {
    var body: some Scene {
        Window("gozd", id: "main") {
            ContentView()
        }
    }
}
```

> [!NOTE]
> シングルウィンドウ運用なら `WindowGroup` ではなく `Window` を使う。
> 公式: 「If your app uses a single window as its primary scene, the app quits when the window closes.」 — gozd の挙動として望ましい。

- `@Environment(\.openWindow) openWindow` で `id` 指定再オープン可能
- 既に開いていれば既存ウィンドウが前面化される
- visionOS では volumetric window style は非対応

#### `WindowGroup`（採用しない）

複数ウィンドウ・データ駆動ウィンドウ用。今回は単一ウィンドウ方針なので非採用。マルチリポは window 内のサイドバーで切り替える（[issue #310](https://github.com/miyaoka/gozd/issues/310)）。

### Liquid Glass

詳細は [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass) を参照。

gozd 関連で重要な点のみ:

- Xcode 26 で再ビルドするだけで標準コンポーネントは自動適用される
- gozd の場合、UI は WebView 内のため Liquid Glass は **ウィンドウクローム / titleBar / 標準メニュー** にしか乗らない
- カスタム背景は外す（titleBar に変な背景を当てない）
- WebView の `webViewContentBackground` は `.hidden` にして、ネイティブの背景とブレンドさせる検討余地あり

### Foundation `Process`（macOS 10.0+）

git / gh などの外部 CLI 実行用。

- `class func run(URL, arguments: [String], terminationHandler:) throws -> Process`
- `func run() throws` / `terminate()` / `interrupt()` / `waitUntilExit()`
- `var standardInput / standardOutput / standardError: Any?` — `Pipe` または `FileHandle` を割り当てる
- `var processIdentifier: Int32`
- `var environment: [String: String]?`
- `var currentDirectoryURL: URL?`
- `var terminationHandler: ((Process) -> Void)?`
- `Sendable` 準拠

> [!WARNING]
> サンドボックスアプリでは子プロセスが親のサンドボックスを継承する。gozd は開発者ツールなのでサンドボックスは外す方針が現実解。Mac App Store には出さない（手元配布 + Notarize）。

### Network framework `NWListener`（macOS 10.14+）

CLI から `gozd open <path>` 等を受ける Unix Domain Socket サーバー実装に使う。

- `init(using: NWParameters, on: NWEndpoint.Port) throws`
- `func start(queue: DispatchQueue)`
- `var newConnectionHandler: ((NWConnection) -> Void)?`
- `var stateUpdateHandler: ((NWListener.State) -> Void)?`
- `func cancel()`
- `Sendable` 準拠

`NWParameters` で Unix Domain Socket を指定する具体パターンは未調査。実装時に確認する。

### CoreServices `File System Events`（FSEvents）

ディレクトリ階層の再帰的変更通知。

- `FSEventStreamCreate(allocator, callback, context, paths, sinceWhen, latency, flags) -> FSEventStreamRef?`
- `FSEventStreamSetDispatchQueue(stream, queue)` — モダンな登録方法（`ScheduleWithRunLoop` は deprecated）
- `FSEventStreamStart(stream) -> Bool`
- `FSEventStreamStop(stream)`
- `FSEventStreamInvalidate(stream)` / `FSEventStreamRelease(stream)`
- `FSEventStreamSetExclusionPaths(stream, paths) -> Bool` — `node_modules` 等の除外
- `FSEventStreamFlushSync(stream)` / `FSEventStreamFlushAsync(stream)`

C API なので `UnsafeMutablePointer` 経由の context 受け渡しが必要。Swift から薄くラップする。

## 確認済み: 配布・低レイヤ API

### Unix Domain Socket on `NWListener`

CLI から desktop へのソケット通信に使う。

- `NWEndpoint` には `case unix(path: String)` が macOS 10.14+ で存在する（出典: NWEndpoint ドキュメント）
- `NWParameters` のクラスプロパティ `.tcp` / `.tls` / `.udp` / `.dtls` / `.quic(...)` には Unix 用プリセットは無い
- `NWParameters.requiredLocalEndpoint: NWEndpoint?` に `.unix(path:)` を設定して使う
- `NWListener.init(using: NWParameters, on: NWEndpoint.Port)` の `port` 引数は Unix Socket では無視される（Unix 経路で listen される）

```swift
let params = NWParameters.tcp
params.requiredLocalEndpoint = NWEndpoint.unix(path: socketPath)
params.allowLocalEndpointReuse = true
let listener = try NWListener(using: params)
```

> [!NOTE]
> 上記コードパターンの厳密な裏付けは Apple 公式の単一ページからは確認できなかった。NWEndpoint.unix と NWParameters.requiredLocalEndpoint は両方とも公式 API だが、組み合わせは慣用的な使い方。実装時に動作検証する。

### Swift Package Manager: macOS 26 指定（確認済み）

出典: [SupportedPlatform.MacOSVersion](https://developer.apple.com/documentation/packagedescription/supportedplatform/macosversion)

- `static let v26: SupportedPlatform.MacOSVersion` が公式に存在
- macOS 16〜25 はスキップされ、15 から直接 26 に飛んでいる（年号と OS バージョンを揃えた Apple の方針）

```swift
// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "Gozd",
    platforms: [.macOS(.v26)],
    targets: [.executableTarget(name: "Gozd")]
)
```

### `NSApplicationDelegateAdaptor`（macOS 11.0+）

出典: [NSApplicationDelegateAdaptor](https://developer.apple.com/documentation/swiftui/nsapplicationdelegateadaptor)

- `@propertyWrapper struct NSApplicationDelegateAdaptor<DelegateType>`
- `DelegateType: NSObject, NSApplicationDelegate` 必須
- ObservableObject 準拠なら自動で Environment に登録される
- App declaration 内で **1 回だけ** 宣言すること（複数宣言はランタイムエラー）

```swift
class AppDelegate: NSObject, NSApplicationDelegate, ObservableObject {
    func applicationDidFinishLaunching(_ notification: Notification) { ... }
    func application(_ sender: NSApplication, openURLs urls: [URL]) { ... }
}

@main struct Gozd: App {
    @NSApplicationDelegateAdaptor private var appDelegate: AppDelegate
    var body: some Scene { ... }
}
```

> [!IMPORTANT]
> 公式ガイダンス: 「Manage an app's life cycle events without using an app delegate whenever possible. Prefer to handle changes in `ScenePhase` instead.」 — 単純な lifecycle なら `@Environment(\.scenePhase)` 優先。AppDelegate はメニューバーカスタマイズや `application(_:openURLs:)` のような AppKit 固有のフックが必要な場合に限定する

### PTY（POSIX、macOS 26.4 で動作確認）

出典: ローカル `man forkpty`（OPENPTY(3)）, `man posix_openpt`（GRANTPT(3)）

#### 選択肢

```c
// 選択肢 A: BSD ユーティリティ（簡潔）
#include <util.h>
pid_t forkpty(int *aprimary, char *name, struct termios *termp, struct winsize *winp);

// 選択肢 B: POSIX 標準（冗長だが移植性高）
#include <stdlib.h>
int posix_openpt(int oflag);
int grantpt(int fildes);
int unlockpt(int fildes);
int ptsname_r(int fildes, char *buffer, size_t buflen);  // ptsname(3) のスレッドセーフ版
```

#### 採用方針

`forkpty(3)` を `<util.h>` 経由で C ブリッジから呼ぶ。`name` 引数は man page が `ptsname_r(3)` 利用を推奨しているのでバッファ長注意（128 bytes 以上、実用上は不要なら NULL 渡しで OK）。

#### fork 安全性（重要）

`forkpty` は内部で `openpty + fork + login_tty` を行う。子プロセス側で:

- ARC / Swift heap allocation / Swift Standard Library に触れない
- 必要な情報（argv, envp, cwd）は fork 前に C 配列（`UnsafeMutablePointer`）として確保
- 子側では C ランタイムの `execve` / `chdir` / `close` 等のみ使用

`Foundation.Process` はこの問題を内部で対処済みだが、**PTY を扱えない**。PTY が必要な場面（ターミナル）でのみ C ブリッジを書き、それ以外（git / gh）は `Process` を使う。

#### Window size 同期

```c
struct winsize ws = { rows, cols, 0, 0 };
ioctl(primary_fd, TIOCSWINSZ, &ws);
```

xterm.js のリサイズイベントを RPC 経由で受け取り、ioctl で PTY に通知する。

### Hardened Runtime / Notarize（確認済み）

出典: [Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime), [Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)

- **Notarize には Hardened Runtime 必須**
- 必要なもの:
  - Developer ID 証明書（Mac Distribution / ad-hoc / dev 証明書はダメ）
  - secure timestamp 付きコード署名
  - macOS 10.9+ SDK リンク（Tahoe ターゲットなら自動的に満たす）
  - `com.apple.security.get-task-allow` を含めない
- ツール: **`notarytool`** が現行（2023-11 以降 `altool` は廃止）+ `stapler` でチケット埋め込み
- 配布形式: `.app` バンドルだけでなく `.dmg` / `.pkg` / `.zip` も notarize 可能
- Mac App Store には出さない方針なので Sandbox は不要

#### gozd で必要になる entitlement の見立て

- Hardened Runtime 自体は有効化（必須）
- 子プロセス（git, gh, zsh, claude 等）を Process / forkpty で起動するが、これは Hardened Runtime の制約対象外（自分のプロセス内で JIT/code injection しないかが論点）
- WebView 内で JS を動かすが、これは WebKit の枠内なので問題なし
- 以下は **不要** と思われる（実装時に再検証）:
  - `com.apple.security.cs.allow-jit`
  - `com.apple.security.cs.allow-unsigned-executable-memory`
  - `com.apple.security.cs.disable-library-validation`

### CLI バンドル

`apps/native/Resources/bin/gozd` シェルラッパー → `Contents/MacOS/bun` ではなく Swift で書いた CLI バイナリを起動する形に置き換える。`forkpty` は CLI 側では不要（CLI は短命プロセスで socket 経由のメッセージ送信のみ）。

## スパイクで実証された事実

[`miyaoka/gozd-spike`](https://github.com/miyaoka/gozd-spike) で macOS 26.4 / Xcode 26 / Swift 6.3 環境で全ケース動作確認済み。

### WebKit for SwiftUI（実機検証済）

- `URLScheme` の正しいイニシャライザは **`URLScheme("gozd-rpc")!`**（無ラベル）。`URLScheme(rawValue:)` は extraneous label でコンパイルエラー
- `URLSchemeHandler.reply(for:)` の戻り値型は `AsyncThrowingStream<URLSchemeTaskResult, Error>` で適合
- WebView の baseURL は独自スキーム（例: `gozd-spike://localhost/`）にすると CORS が適切に発火する。`HTTPURLResponse` で `Access-Control-Allow-Origin: *` を返せば fetch は通る
- `WebPage.callJavaScript("window.__recv(type, payload)", arguments: ["type": ..., "payload": ...])` で Swift → JS が動作。引数 dict のキーが JS 関数本体内で変数として参照可能
- `page.isInspectable = true` で Web Inspector が利用可能

### NWListener + Unix Socket（公式パターンが macOS 26 で動作）

正しいパターンは Apple DTS Quinn "The Eskimo!" の公式回答（[Forums #719635](https://developer.apple.com/forums/thread/719635) / [#756756](https://developer.apple.com/forums/thread/756756)）:

```swift
let params = NWParameters()                                              // 空 init
params.defaultProtocolStack.transportProtocol = NWProtocolTCP.Options()  // TCP options を後から代入
params.requiredLocalEndpoint = NWEndpoint.unix(path: socketPath)
params.allowLocalEndpointReuse = true

let listener = try NWListener(using: params)
```

> [!IMPORTANT]
> `NWParameters.tcp`（プリセット）は **Unix endpoint と組み合わせて使えない**。空 init してから `transportProtocol` に `NWProtocolTCP.Options()` を代入するのが正解。
>
> 接続側は `connection.start(queue:)` 直後に `receive` を呼んではいけない。`stateUpdateHandler` で `.ready` に遷移してから `receive` を開始する。
>
> 起動ログに `nw_path_evaluator_create_flow_inner [22: Invalid argument]` 等の警告が大量に出るが、Quinn 公認で **just log noise**。動作には影響しない。
>
> `sun_path` は 108 byte 制限。`/tmp/gozd-{channel}.sock` 程度なら余裕。サンドボックスのコンテナパス（長い）を使う場合のみ注意。

### POSIX socket クライアントの shutdown パターン（必須）

Swift CLI（`socket()` + `connect()` で接続）が NWListener サーバーに送信する場合:

```swift
write(fd, payload, len)
shutdown(fd, Int32(SHUT_WR))   // 「もう書きません」FIN を送信
// EOF まで read drain（任意だが安全）
while read(fd, &sink, sink.count) > 0 {}
close(fd)
```

`write()` 直後に `close(fd)` すると **NWListener が accept する前に FIN が届いて受信されない race** が発生する（`nc -U` は内部で同等の処理をしているので動く）。CLI 側の標準作法として必須。

### PTY (`forkpty`) + DispatchSourceRead

```swift
import CPty   // <util.h> を expose する SPM C target

var ws = winsize(ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0)
var fd: Int32 = -1
let pid = forkpty(&fd, nil, nil, &ws)  // name は nil でOK（128 byte buffer 事故を回避）
if pid == 0 {
    chdir(cCwd)
    execve(cExecutable, cArgv, cEnvp)
    _exit(127)
}
// 親側
let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .global(qos: .userInitiated))
source.setEventHandler { /* read(fd, ...) → onData */ }
source.resume()

// resize
ioctl(fd, TIOCSWINSZ, &ws)

// 終了時: SIGHUP（SIGTERM では interactive zsh が無視するため不可）
kill(pid, SIGHUP)

// waitpid status の decode（C マクロが Swift から呼べないので手動）
// status & 0x7F == 0 → exited、(status >> 8) & 0xFF が exit code
// status & 0x7F == 0x7F → stopped
// それ以外 → signaled、status & 0x7F が signal、status & 0x80 が core dump bit
```

CPty は `Sources/CPty/include/CPty.h` で `#include <util.h>` 等を expose、`CPty.c` は `#include "CPty.h"` のみのスケルトン。Swift から直接 `forkpty` / `ioctl` / `TIOCSWINSZ` が見える。

### `swift run` で起動する GUI アプリの activation

`@main` の SwiftUI App を `.app` バンドル外（`swift run` 経由）で起動するとフォアグラウンドアプリとしてアクティベートされず、キー入力が起動元ターミナルに残る。`NSApplicationDelegateAdaptor` で:

```swift
func applicationDidFinishLaunching(_ n: Notification) {
    setbuf(stdout, nil); setbuf(stderr, nil)  // GUI app の stdout は block buffered なので解除
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
}
```

### SPM ビルドの致命的な罠

| コマンド                  | 効果                                                           |
| ------------------------- | -------------------------------------------------------------- |
| `swift build`             | 全 product をビルド・リンク                                    |
| `swift build --product X` | product X をビルド・**リンク**（実行可能な exe を生成）        |
| `swift build --target X`  | target X の **Swift モジュールをコンパイルのみ**、リンクしない |

> [!CAUTION]
> `--target X` でも `Build of target: 'X' complete!` という success メッセージが出るが、**executable は更新されない**。「変更が反映されない」「動かない」と思った時、実は古いバイナリを実行している可能性が高い。個別ビルドは必ず `--product` を使う。

### gozd 本体への適用

- 通信経路はすべてスパイクのパターンをそのまま流用（`gozd-rpc://` URLSchemeHandler、`gozd-file://`、Unix Socket）
- xterm.js は CDN ロードか vendor
- View 以外（RPC・composable・store・shared）は新規作成。Vue SFC の `<template>` / `<style>` / 純粋な表示ロジックのみ既存 `apps/renderer/` から移植
- PTY 出力の UTF-8 マルチバイト境界バッファリングは Swift 側で `UTF8StreamDecoder` 相当を実装する必要あり（スパイクでは `String(decoding:as:)` 任せで未検証）

## 残る未確認領域

実装直前に手を動かして決める:

- **xterm.js への PTY バイトストリーム送信時の文字化け対策** — UTF-8 のマルチバイト境界での切れ。スパイクでは ASCII / 日本語短文のみ動作確認、長時間ストリームでの境界 race は未検証
- **マルチリポ対応 RPC の `.proto` 具体形** — issue #310 のステートレス化（全 RPC に `dir` パラメータ必須）を Protobuf message としてどう設計するか

## スパイクで実証された事実（追加）

### FSEvents の Swift 6 ラップパターン（[gozd-spike#FSEventsTest, FSWatcherClassTest](https://github.com/miyaoka/gozd-spike) で検証済）

必須フラグ:

```swift
let flags: FSEventStreamCreateFlags =
    UInt32(kFSEventStreamCreateFlagFileEvents)
    | UInt32(kFSEventStreamCreateFlagNoDefer)
    | UInt32(kFSEventStreamCreateFlagUseCFTypes)
```

> [!IMPORTANT]
> **`UseCFTypes` 必須**。これがないと callback の `eventPaths` は `char**` で、`unsafeBitCast(_, to: NSArray.self)` が UB → SIGSEGV。

class wrapper の Swift 6 strict concurrency 対応:

> [!CAUTION]
> **`@unchecked Sendable` を付けてはいけない**。
>
> Swift 6 analyzer は non-Sendable class を見ると cross-actor 送信不可で打ち切り、内部の `OpaquePointer` (`FSEventStreamRef`) を解析しない。逆に `@unchecked Sendable` を付けると「Sendable と称するなら検証する」モードに入り、`OpaquePointer` を持つフィールドで SendNonSendable パスが SIGABRT する（Swift 6.3 / Xcode 26 で実測、本実装ブランチで一度踏んだ）。
>
> Apple `swift-tools-support-core/Sources/TSCUtility/FSWatch.swift` の `FSEventStream` も同流儀（Sendable 適合なし）。利用側は単一 context（@MainActor または専用 actor）から使う前提。

`OpaquePointer` の Sendable 化は SE-0331（Swift 5.6, 2022）で `@available(*, unavailable) extension OpaquePointer: Sendable {}` として明示的に禁止されており、再 Sendable 化の計画もない（一次ソース: [`stdlib/public/core/CTypes.swift`](https://github.com/swiftlang/swift/blob/main/stdlib/public/core/CTypes.swift)）。

採用しなかった flag:

- `WatchRoot`: gozd の現用途（worktree 配下監視）では root 移動シナリオが希。必要時に追加検討
- `IgnoreSelf`: gozd 経由（PTY spawn 等）の書き込みも UI 更新したいので不採用

## アーキテクチャ案

```text
┌─ Swift App プロセス（in-process バックエンド込み） ─────────┐
│                                                              │
│  SwiftUI Window                                              │
│  └─ WebView（全画面）                                        │
│      └─ Vue renderer（既存）                                 │
│         サイドバー（マルチ repo）/ ターミナル / Filer 等     │
│         全部 WebView 内で動く                                │
│                                                              │
│  Swift Backend（同一プロセス）                                │
│  ├─ RPCBridge（gozd-rpc:// URLSchemeHandler）                │
│  ├─ FileServer（gozd-file:// URLSchemeHandler）              │
│  ├─ PTYManager（forkpty + DispatchIO）                      │
│  ├─ FSWatcher（FSEventStreamCreate）                        │
│  ├─ GitOps（Process → git/gh）                              │
│  ├─ SocketServer（NWListener, NDJSON）                      │
│  ├─ ClaudeHooks（JSON 設定生成）                             │
│  └─ StatePersistence（Codable JSON）                         │
└──────────────────────────────────────────────────────────────┘
         ▲
         │ Unix Domain Socket（NDJSON）
         ▼
  ┌────────────────┐
  │ CLI（Swift）   │  既存 Bun 版から書き直し
  │ gozd open / hook│
  └────────────────┘
```

### 通信レイヤー

| 経路                           | 方式                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vue → Swift（request）         | `fetch("gozd-rpc://<name>", { method: "POST", body })` → `URLSchemeHandler.reply(for:)` が `HTTPURLResponse + payload` を返す。型は `.proto` から生成 |
| Vue → Swift（fire-and-forget） | 同上で `204 No Content` を返す                                                                                                                        |
| Swift → Vue                    | `WebPage.callJavaScript("window.__gozdReceive(type, payload)", arguments: …)`。型は `.proto` から生成                                                 |
| ファイル配信                   | `fetch("gozd-file://<path>")` → `URLSchemeHandler`                                                                                                    |
| CLI → Swift                    | Unix Domain Socket（`NWListener`）+ NDJSON                                                                                                            |

> [!NOTE]
> ワイヤーフォーマットは proto3 JSON mapping を第一候補とする。Protobuf binary は JS 側で扱いが煩雑（base64 / Uint8Array）になるため、まずは JSON で通し、性能ボトルネックが見えたときに binary 化を検討する。型定義は `.proto` を SSOT とし、ts-proto / swift-protobuf 生成型で送受信する点は変わらない。

### CORS の罠

`URLResponse` ではなく `HTTPURLResponse` を返し `Access-Control-Allow-Origin: *` を必ず付ける。

### renderer 側の構成

renderer は新規構築する。流用するのは Vue SFC の View 層（テンプレート / スタイル / 純粋な表示ロジック）のみ。

- `shared/rpc/` 一式は新規作成。`fetch("gozd-rpc://...")` ベースのトランスポート + ts-proto 生成型を組み合わせる
- composable / store の RPC 接続部はすべて書き直し。`packages/rpc/`（Electrobun RPC 前提）は最終的に削除
- View は既存 SFC の `<template>` / `<style>` を移植。props 経由で受け取った値を描画するだけのコンポーネントは無変更で動く
- 状態管理を伴うコンポーネントは、新しい store の API に合わせて `<script>` 部分を書き直す

### マルチリポジトリ対応（issue #310 連携）

[issue #310](https://github.com/miyaoka/gozd/issues/310) の方針と統合する:

- すべての RPC は `dir` パラメータを必須化（ステートレス）
- `currentDir` をバックエンドが暗黙保持しない
- `FSWatcher` は repo 単位で常時稼働、`fsChange` メッセージに `dir` を含める
- 全 repo の全 worktree の Claude ステータスをサイドバー（WebView 内）に表示

## 実装フェーズ案

| フェーズ    | 検証ゴール                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Phase 0** | `apps/native/` を新規作成。空の SwiftUI `Window` + `WebView(WebPage())` + `URLSchemeHandler` で echo RPC が往復する。`packages/proto/` を初期化して buf + ts-proto + swift-protobuf の生成パイプラインを通す |
| **Phase 1** | バックエンドコア: PTY / FSWatcher / NWListener を Swift で新規実装                                                                                                                                           |
| **Phase 2** | Git ops + 状態永続化 + Claude hooks。RPC スキーマを `.proto` で定義                                                                                                                                          |
| **Phase 3** | renderer 新規構築。View（Vue SFC のテンプレート/スタイル）を既存 `apps/renderer/` から移植、`shared/rpc/` と composable / store は新規作成。シングルウィンドウ・マルチリポ対応（issue #310）                 |
| **Phase 4** | 配布: Xcode Archive + Notarize、CLI バンドル、`gozd` シェルラッパー差し替え、Sparkle 検討                                                                                                                    |
| **Phase 5** | `apps/desktop/` / `apps/cli/`（旧 Bun 版）/ `packages/rpc/`（旧 Electrobun スキーマ） / Electrobun 依存（`pnpm-workspace.yaml`、`package.json` 等）を削除                                                    |

各フェーズの完了は **動作する成果物** で測る。Phase 0 完了 = Vue renderer なしで Swift 単体の echo が確認できる、Phase 3 完了 = 既存の renderer がそのまま動く、等。

## 参考リンク（公式のみ）

- [WebKit for SwiftUI](https://developer.apple.com/documentation/webkit/webkit-for-swiftui)
- [WebView](https://developer.apple.com/documentation/webkit/webview-swift.struct)
- [WebPage](https://developer.apple.com/documentation/webkit/webpage)
- [WebPage.Configuration](https://developer.apple.com/documentation/webkit/webpage/configuration)
- [URLSchemeHandler](https://developer.apple.com/documentation/webkit/urlschemehandler)
- [URLScheme](https://developer.apple.com/documentation/webkit/urlscheme)
- [URLSchemeTaskResult](https://developer.apple.com/documentation/webkit/urlschemetaskresult)
- [WebPage.NavigationEvent](https://developer.apple.com/documentation/webkit/webpage/navigationevent)
- [WebPage.NavigationDeciding](https://developer.apple.com/documentation/webkit/webpage/navigationdeciding)
- [SwiftUI Window](https://developer.apple.com/documentation/swiftui/window)
- [SwiftUI WindowGroup](https://developer.apple.com/documentation/swiftui/windowgroup)
- [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass)
- [Foundation Process](https://developer.apple.com/documentation/foundation/process)
- [Network NWListener](https://developer.apple.com/documentation/network/nwlistener)
- [Network NWParameters](https://developer.apple.com/documentation/network/nwparameters)
- [Network NWEndpoint](https://developer.apple.com/documentation/network/nwendpoint)
- [CoreServices File System Events](https://developer.apple.com/documentation/coreservices/file_system_events)
- [PackageDescription SupportedPlatform](https://developer.apple.com/documentation/packagedescription/supportedplatform)
- [PackageDescription SupportedPlatform.MacOSVersion](https://developer.apple.com/documentation/packagedescription/supportedplatform/macosversion)
- [SwiftUI NSApplicationDelegateAdaptor](https://developer.apple.com/documentation/swiftui/nsapplicationdelegateadaptor)
- [Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime)
- [Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- ローカル man pages: `forkpty(3)` (OPENPTY), `posix_openpt(3)` (GRANTPT) — macOS 26.4 で確認
- [issue #310: シングルウィンドウ・マルチリポジトリ](https://github.com/miyaoka/gozd/issues/310)
