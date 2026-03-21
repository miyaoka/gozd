# Electrobun

Bun ランタイム + WKWebView のデスクトップアプリフレームワーク。Electron の代替として採用。

## 選択理由

- Bun ランタイムで起動が高速
- `Bun.spawn({ terminal })` で PTY をネイティブサポート（node-pty 不要）
- 型安全な RPC（`ElectrobunRPCSchema`）で bun ↔ webview 間通信が宣言的に書ける
- WKWebView ベースで軽量

## アーキテクチャ

```mermaid
flowchart TB
    subgraph desktop [desktop / bun プロセス]
        MAIN[index.ts]
        PTY[PTY 管理]
        WATCH[ファイル監視]
        SOCKET[ソケットサーバー]
        LSP[LSP クライアント]
        MAIN --> PTY
        MAIN --> WATCH
        MAIN --> SOCKET
        MAIN --> LSP
    end

    subgraph renderer [renderer / WKWebView]
        VUE[Vue アプリ]
    end

    subgraph cli [CLI]
        ORKIS[orkis コマンド]
    end

    desktop <-->|Electrobun RPC| renderer
    cli -->|Unix socket| desktop
```

## WKWebView の制約

- `file://` URL をブロック → desktop 側でローカル HTTP ファイルサーバー（`Bun.serve()`）を起動して配信
  - `/{windowId}/fs/{relPath}` — 現在のファイル
  - `/{windowId}/git/{relPath}` — HEAD 時点のファイル（`git show`）
  - バイナリ判定: NUL バイト + 1MB サイズ制限
  - Content-Type は `Bun.file().type` から自動推定
- `window.open()` が機能しない → RPC の `openExternal` 経由で `Utils.openExternal()` を呼ぶ

## ビルド構成

- **dev**: Vite HMR サーバー（`localhost:5173`）を WKWebView で表示
- **build**: renderer を Vite でビルドし、成果物を `views/main/` にコピー
- **views エントリポイント**: `src/placeholder.ts`（空ファイル。実際の UI は renderer の build 成果物）

## ウィンドウ管理

- ディレクトリごとに1ウィンドウ（同じディレクトリの重複不可）
- `windowDirs` Map で dir → ウィンドウの対応を管理
- `projectDir`（clone 元、固定）と `currentDir`（切り替え可能な worktree パス）を分離
- ウィンドウ close 時に全リソース（PTY, watcher, timer, LSP）をクリーンアップ
- `exitOnLastWindowClosed: true` で最後のウィンドウを閉じるとアプリ終了

### Worktree 切り替え（switchDir）

ウィンドウを閉じずに表示対象ディレクトリを切り替える。切り替え時の処理:

- ファイル監視の付け替え（stopWatching → startWatching）
- LSP クライアントの再起動
- 世代番号（`windowSwitchGen`）のインクリメントで stale な結果を破棄

### 非アクティブ worktree 監視

アクティブでない worktree の `.git/index` を `fs.watchFile` で監視し、ファイル変更を検知して `worktreeChange` メッセージを送信する。`syncWorktreeWatchers()` でアクティブ/非アクティブの切り替えに応じてウォッチャーを動的に管理する。

## 起動フロー

launcher（main.zig）は bun を固定引数（`./bun`, `Resources/main.js`）で起動する。`open --args` の引数は bun の `process.argv` に転送されない。

### 起動パターン

| 起動方法                 | 動作                                                                           |
| ------------------------ | ------------------------------------------------------------------------------ |
| `pnpm dev`               | `ORKIS_PROJECT_ROOT` 環境変数で即座にウィンドウを開く                          |
| `.app` 内 CLI cold start | CLI が launch request ファイルを書く → アプリが読み取り → 正式ウィンドウを作成 |
| `.app` 内 CLI warm start | ソケット経由で open メッセージを送信 → 新しいウィンドウを追加                  |
| Dock/Finder/`pnpm open`  | launch request なし → ホームディレクトリでスタートアップ画面                   |

> [!IMPORTANT]
> 初回ウィンドウは必ず同期的に作成する。macOS の role メニュー（Copy, Paste 等）は responder chain に依存するため、key window が存在しない状態ではメニューが動作しない。

### launch request ファイル

CLI cold start 時に、アプリ起動前に `$TMPDIR/orkis-stable-launch/{uuid}.json` へ `{ targetPath }` を書く。アプリは起動時に `readdirSync` + `readFileSync` で同期的に読み取り、処理済みファイルは `.claimed` にリネームする。TTL（30秒）超過のファイルは起動時に掃除する。読み取り失敗時は `Utils.showMessageBox` でエラーダイアログを表示する。

CLI は絶対パス（`targetPath`）をそのまま送信するメッセンジャーに徹する。desktop 側で `resolveOpenTarget(targetPath)` により、プロジェクト判定（`--git-common-dir`）、worktree 解決（`--show-toplevel`）、ファイル/ディレクトリの判定を一括で行う。

### CLI とアプリの起動の違い

| 観点               | CLI（`orkis`）                                      | アプリ（Dock/Finder/`pnpm open`）      |
| ------------------ | --------------------------------------------------- | -------------------------------------- |
| path               | 常に明示的（cwd）                                   | 未指定                                 |
| スタートアップ画面 | 不要                                                | 将来的に最近のプロジェクト履歴から選択 |
| ターミナルの cwd   | 指定された path                                     | ホームディレクトリ                     |
| repo なしの path   | worktrees を出さず、ターミナル + ファイラとして起動 | —                                      |

### ソケット通信

- ソケットは「既に起動済みのアプリへの追加 open」専用
- ソケットパスは `$TMPDIR/orkis-stable.sock`（`Updater.localInfo.channel()` は `build:stable` で `"stable"` を返す）
- CLI → アプリへのメッセージ: `open`（targetPath）、`hook`（event, payload）
- open メッセージの targetPath は CLI からの絶対パス。desktop 側で `resolveOpenTarget` により解決される
- 残骸ソケットの検出には `echo "" | nc -U`（macOS デフォルトの `nc -zU` では Node.js ソケットへの接続テストが失敗する）

### シングルインスタンス制御

- 起動時に既存ソケットへの接続を試行
- 接続成功 → 既存インスタンスが存在 → exit
- 接続失敗 → 残骸ソケットを削除して新規起動

## セキュリティ

@docs/desktop.md のパス検証・プロトコル制限セクションを参照。
