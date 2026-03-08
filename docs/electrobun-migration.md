# Electron → Electrobun 移行計画

issue: #29

## 目的

デスクトップフレームワークを Electron から Electrobun に移行し、以下を達成する：

- Bun ランタイムへの統一（メインプロセス）
- ネイティブモジュール依存の解消（node-pty, @parcel/watcher）
- バンドルサイズの大幅削減（Chromium バンドルの排除）
- 型付き RPC による IPC のモダン化

## 技術的前提

- Electrobun v1.15.1
- Bun.spawn の `terminal` オプションで PTY をネイティブサポート（POSIX のみ、Windows 対象外）
- Electrobun の RPC は `ElectrobunRPCSchema` 型で bun ↔ webview 間の通信を型安全に定義
- `ElectrobunRPCSchema` は `bun` と `webview` の 2 側面を持ち、それぞれが `requests`（双方向）と `messages`（一方向）を定義する
- Vue + Vite のビルド成果物は Electrobun の `build.copy` で views/ にマッピング
- Electrobun の API ソースは `ghq list -p | grep electrobun` で参照可能

## 現在の構成

```
apps/
├── electron/          # Electron メインプロセス（node-pty, @parcel/watcher）
├── renderer/          # Vue フロントエンド（ghostty-web, Tailwind）
├── cli/               # orkis CLI
packages/
├── preload/           # Electron preload（contextBridge）
└── shared/            # 共通ユーティリティ（tryCatch, Result）
```

## 移行後の構成

```
apps/
├── desktop/           # Electrobun メインプロセス（Bun ランタイム）
├── renderer/          # Vue フロントエンド（変更あり）
├── cli/               # orkis CLI（変更なし）
packages/
├── rpc/               # RPC スキーマ定義（desktop と renderer で共有）
└── shared/            # 共通ユーティリティ（変更なし）
```

## パッケージの責務

### apps/desktop（新規）

Electrobun のメインプロセス。Bun ランタイムで動作する。

依存: `electrobun`, `@orkis/rpc`, `@orkis/shared`

責務:

- BrowserWindow の作成・管理
- `BrowserView.defineRPC` による RPC ハンドラの実装（bun 側）
- PTY 管理（`Bun.spawn` の `terminal` オプション）
- ファイル監視（`node:fs.watch` recursive）
- Git status の取得・通知
- CLI との Unix ドメインソケット通信
- `openExternal` のプロトコルバリデーション（`http/https` のみ許可）

### apps/renderer（既存、変更あり）

Vue フロントエンド。Vite でビルドする。

依存の変更:

- 追加: `electrobun`（`electrobun/view` の RPC ランタイム）, `@orkis/rpc`
- 削除: `@orkis/preload`

変更内容:

- `window.api.*` の呼び出しを `electrobun.rpc!.request` / `electrobun.rpc!.send` に置き換え
- `Electroview.defineRPC` + `new Electrobun.Electroview({ rpc })` で RPC 初期化
- Electron 固有の CSP を削除

### packages/rpc（新規）

desktop と renderer の通信契約を定義する型パッケージ。

依存: `electrobun`（`import type` のみ。ランタイム依存なし）

内容:

- `OrkisRPC` 型（`ElectrobunRPCSchema` ベース、`bun` / `webview` の 2 側面を持つ）
- `FileEntry` インターフェース（name, isDirectory, isIgnored）

### packages/preload（削除）

Electrobun では Electron の `contextBridge` に相当する仕組みが不要（RPC が代替）。Electrobun 自体には `preload` オプションが存在するが、orkis では使用しない。

## RPC スキーマ設計

Electrobun の `ElectrobunRPCSchema` に従い、`bun` と `webview` それぞれの `requests`（双方向、Promise ベース）と `messages`（一方向）を定義する。

> [!IMPORTANT]
> Electrobun の RPC では、各側面の `requests` はその側が **受信して処理する** リクエストを定義する。`messages` はその側から **送信する** メッセージを定義する。つまり:
>
> - `bun.requests` = webview → bun のリクエスト（bun が処理）
> - `bun.messages` = bun → webview のメッセージ（bun が送信）
> - `webview.requests` = bun → webview のリクエスト（webview が処理）
> - `webview.messages` = webview → bun のメッセージ（webview が送信）

### 型定義（packages/rpc/src/index.ts）

```ts
import type { RPCSchema } from "electrobun/bun";

export interface FileEntry {
  name: string;
  isDirectory: boolean;
  isIgnored: boolean;
}

export type OrkisRPC = {
  bun: RPCSchema<{
    requests: {
      ptySpawn: {
        params: { cols: number; rows: number };
        response: number;
      };
      fsReadDir: {
        params: { relPath: string };
        response: FileEntry[];
      };
      gitStatus: {
        params: undefined;
        response: Record<string, string>;
      };
    };
    messages: {
      ptyData: { id: number; data: string };
      ptyExit: { id: number; exitCode: number };
      fsChange: { relDir: string };
      gitStatusChange: { statuses: Record<string, string> };
      orkisOpen: { dir: string; file?: string };
      orkisHook: { event: string; payload: Record<string, unknown> };
    };
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      ptyWrite: { id: number; data: string };
      ptyResize: { id: number; cols: number; rows: number };
      ptyKill: { id: number };
      openExternal: { url: string };
      rendererReady: void;
    };
  }>;
};
```

### 通信方向の整理

| 方向          | 種別    | メソッド          | 説明                           |
| ------------- | ------- | ----------------- | ------------------------------ |
| webview → bun | request | `ptySpawn`        | PTY プロセスを起動し ID を返す |
| webview → bun | request | `fsReadDir`       | ディレクトリの内容を読み取る   |
| webview → bun | request | `gitStatus`       | git status を取得する          |
| webview → bun | message | `ptyWrite`        | PTY にデータを書き込む         |
| webview → bun | message | `ptyResize`       | PTY をリサイズする             |
| webview → bun | message | `ptyKill`         | PTY を終了する                 |
| webview → bun | message | `openExternal`    | 外部 URL を開く                |
| webview → bun | message | `rendererReady`   | renderer の準備完了を通知      |
| bun → webview | message | `ptyData`         | PTY からの出力データ           |
| bun → webview | message | `ptyExit`         | PTY プロセスの終了             |
| bun → webview | message | `fsChange`        | ファイル変更通知               |
| bun → webview | message | `gitStatusChange` | git status 変更通知            |
| bun → webview | message | `orkisOpen`       | orkis open コマンド            |
| bun → webview | message | `orkisHook`       | orkis hook イベント            |

## マルチウィンドウと RPC の設計

> [!IMPORTANT]
> `BrowserView.defineRPC` が返す RPC インスタンスは **単一の transport を保持する**。`setTransport()` で上書きされるため、同じ RPC インスタンスを複数の `BrowserWindow` に渡すと後勝ちになり破綻する。

ウィンドウごとに `BrowserView.defineRPC` を呼び、個別の RPC インスタンスを作成する必要がある。

```ts
function createWindowWithRPC(dir: string): BrowserWindow {
  const rpc = BrowserView.defineRPC<OrkisRPC>({
    handlers: {
      requests: {
        ptySpawn: ({ cols, rows }) => spawnPty(dir, cols, rows),
        fsReadDir: ({ relPath }) => readDir(dir, relPath),
        gitStatus: () => getGitStatus(dir),
      },
      messages: {
        ptyWrite: ({ id, data }) => {
          ptys.get(id)?.terminal.write(data);
        },
        ptyResize: ({ id, cols, rows }) => {
          /* リサイズ処理 */
        },
        ptyKill: ({ id }) => {
          ptys.get(id)?.kill();
        },
        openExternal: ({ url }) => {
          // http/https のみ許可（セキュリティ維持）
          if (isAllowedProtocol(url)) Utils.openExternal(url);
        },
        rendererReady: () => {
          win.webview.rpc.send.orkisOpen({ dir });
        },
      },
    },
  });

  const win = new BrowserWindow({
    title: "orkis",
    url: "views://main/index.html",
    frame: { width: 1200, height: 800, x: 100, y: 100 },
    rpc,
  });

  return win;
}
```

### bun → webview メッセージ送信

```ts
// BrowserWindow インスタンス経由でアクセス
win.webview.rpc.send.ptyData({ id, data: text });
win.webview.rpc.send.fsChange({ relDir });
win.webview.rpc.send.gitStatusChange({ statuses });
```

## renderer 側の RPC 統合方針

現状 `window.api` を直接呼んでいるコンポーネント:

| ファイル         | 呼び出し                                                           |
| ---------------- | ------------------------------------------------------------------ |
| App.vue          | onOpen, notifyReady                                                |
| TerminalPane.vue | pty.spawn, pty.onData, pty.onExit, pty.write, pty.resize, pty.kill |
| FilerPane.vue    | fs.readDir(×2), fs.onChange, git.onStatusChange                    |
| FileTreeItem.vue | fs.readDir                                                         |
| useGitStatus.ts  | git.status                                                         |

### RPC 初期化（composable: useRpc.ts）

`electrobun/view` から `Electroview` をインポートし、RPC を初期化する。モジュールレベルで保持し、composable として提供する。

```ts
import Electrobun, { Electroview } from "electrobun/view";
import type { OrkisRPC } from "@orkis/rpc";

// bun → webview メッセージのコールバックリスト（動的リスナー用）
const listeners = {
  ptyData: [] as Array<(payload: { id: number; data: string }) => void>,
  ptyExit: [] as Array<(payload: { id: number; exitCode: number }) => void>,
  fsChange: [] as Array<(payload: { relDir: string }) => void>,
  gitStatusChange: [] as Array<(payload: { statuses: Record<string, string> }) => void>,
  orkisOpen: [] as Array<(payload: { dir: string; file?: string }) => void>,
  orkisHook: [] as Array<(payload: { event: string; payload: Record<string, unknown> }) => void>,
};

const rpc = Electroview.defineRPC<OrkisRPC>({
  handlers: {
    requests: {},
    messages: {
      ptyData: (payload) => {
        for (const fn of listeners.ptyData) fn(payload);
      },
      ptyExit: (payload) => {
        for (const fn of listeners.ptyExit) fn(payload);
      },
      fsChange: (payload) => {
        for (const fn of listeners.fsChange) fn(payload);
      },
      gitStatusChange: (payload) => {
        for (const fn of listeners.gitStatusChange) fn(payload);
      },
      orkisOpen: (payload) => {
        for (const fn of listeners.orkisOpen) fn(payload);
      },
      orkisHook: (payload) => {
        for (const fn of listeners.orkisHook) fn(payload);
      },
    },
  },
});

const electrobun = new Electrobun.Electroview({ rpc });
```

### 呼び出し方

```ts
// request（Promise ベース、bun 側が処理して応答を返す）
const ptyId = await electrobun.rpc!.request.ptySpawn({ cols: 80, rows: 24 });
const entries = await electrobun.rpc!.request.fsReadDir({ relPath: "." });
const statuses = await electrobun.rpc!.request.gitStatus();

// message（一方向、bun 側の handlers.messages で受信）
electrobun.rpc!.send.ptyWrite({ id, data });
electrobun.rpc!.send.ptyResize({ id, cols, rows });
electrobun.rpc!.send.ptyKill({ id });
electrobun.rpc!.send.openExternal({ url });
electrobun.rpc!.send.rendererReady();
```

### bun → webview メッセージの購読

`Electroview.defineRPC` の `handlers.messages` は初期化時に固定登録される。コンポーネントのライフサイクルに合わせた動的リスナーは、composable 内のコールバックリストで管理し、disposer パターンで解除する。

```ts
// useRpc.ts から export する subscribe 関数
function onPtyData(fn: (payload: { id: number; data: string }) => void): () => void {
  listeners.ptyData.push(fn);
  return () => {
    const idx = listeners.ptyData.indexOf(fn);
    if (idx >= 0) listeners.ptyData.splice(idx, 1);
  };
}

// コンポーネントでの使用
const removeListener = onPtyData(({ id, data }) => { ... });
onBeforeUnmount(() => removeListener());
```

## 置き換え対応表

| Electron                           | Electrobun                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `ipcMain.handle(channel, handler)` | `BrowserView.defineRPC` の `handlers.requests`                                |
| `ipcMain.on(channel, handler)`     | `BrowserView.defineRPC` の `handlers.messages`                                |
| `event.sender.send(channel, data)` | `win.webview.rpc.send.messageName(payload)`（BrowserWindow インスタンス経由） |
| `contextBridge.exposeInMainWorld`  | 不要（RPC が代替）                                                            |
| `ipcRenderer.invoke`               | `electrobun.rpc!.request.methodName(params)`                                  |
| `ipcRenderer.send`                 | `electrobun.rpc!.send.messageName(payload)`                                   |
| `ipcRenderer.on`                   | `Electroview.defineRPC` の `handlers.messages` + コールバックリスト           |
| `node-pty` の `pty.spawn`          | `Bun.spawn` の `terminal` オプション                                          |
| `node-pty` の `ptyProcess.onData`  | `Bun.spawn` の `terminal.data(terminal, data)` コールバック                   |
| `node-pty` の `ptyProcess.write`   | `proc.terminal.write(data)`                                                   |
| `node-pty` の `ptyProcess.resize`  | 未提供（Bun 側の制約、要調査）                                                |
| `@parcel/watcher.subscribe`        | `node:fs.watch` (recursive, macOS)                                            |
| `shell.openExternal(url)`          | `Utils.openExternal(url)`（プロトコルバリデーション付き）                     |
| `new BrowserWindow(opts)`          | `new BrowserWindow({ title, url, frame, rpc })`                               |
| `mainWindow.loadURL(url)`          | コンストラクタの `url` パラメータ                                             |
| `mainWindow.loadFile(path)`        | `url: "views://viewName/index.html"`                                          |
| `mainWindow.show()`                | コンストラクタで `hidden: false`（デフォルト）                                |

## electrobun.config.ts

`defineConfig` 関数は存在しない。`satisfies ElectrobunConfig` で型チェックする。

```ts
import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "orkis",
    identifier: "com.miyaoka.orkis",
    version: "0.0.0",
    description: "AI Agent Orchestrator",
  },
  build: {
    bun: {
      entrypoint: "src/index.ts",
    },
    views: {
      main: {
        entrypoint: "src/placeholder.ts",
      },
    },
    copy: {
      "../renderer/dist/": "views/main/",
    },
  },
  runtime: {
    exitOnLastWindowClosed: false,
  },
} satisfies ElectrobunConfig;
```

> [!NOTE]
> `build.copy` のソースパスは `join(projectRoot, relSource)` で解決される（Electrobun CLI 実装による）。`../renderer/dist/` のような相対パスで別ワークスペースの成果物を参照可能。

## Bun.spawn PTY API リファレンス

```ts
const proc = Bun.spawn(["bash"], {
  terminal: {
    cols: 80,
    rows: 24,
    data(terminal, data) {
      // PTY からの出力データ（Uint8Array）
      const text = new TextDecoder().decode(data);
      // bun → webview メッセージ送信（BrowserWindow インスタンス経由）
      win.webview.rpc.send.ptyData({ id, data: text });
    },
    exit() {
      win.webview.rpc.send.ptyExit({ id, exitCode: proc.exitCode ?? 1 });
    },
  },
});

// PTY への書き込み
proc.terminal.write("ls\n");

// リサイズ（Bun の terminal API に resize がない場合は SIGWINCH で対応）
```

> [!WARNING]
> `terminal.resize()` の API 有無は要検証。Bun のバージョンによって未実装の可能性がある。

## fs.watch の信頼性

`node:fs.watch` の recursive オプションは macOS（FSEvents）では安定しているが、Linux（inotify）では制限がある。本プロジェクトは macOS のみを対象とするため問題ないが、Linux 対応が必要になった場合は `chokidar` 等のライブラリを検討する。

## セキュリティ

### openExternal のプロトコルバリデーション

現行 Electron 版では `validateExternalUrl` で `http/https` のみ許可している。Electrobun の `Utils.openExternal` は任意スキームを受け付けるため、bun 側の messages ハンドラで同等のバリデーションを維持する。

```ts
const ALLOWED_PROTOCOLS = new Set(["https:", "http:"]);

function isAllowedProtocol(raw: string): boolean {
  const result = tryCatch(() => new URL(raw));
  if (!result.ok) return false;
  return ALLOWED_PROTOCOLS.has(result.value.protocol);
}
```

### パストラバーサル防止

`fsReadDir` の request ハンドラで、現行と同じ `resolveSecurePath` によるパストラバーサル検証を維持する。

## 機能パリティチェックリスト

移行時に維持すべき既存機能:

- シングルインスタンス制御（Electrobun に相当 API がないため、ソケットの存在チェックまたは PID ファイルで自前実装）
- マルチウィンドウ管理（`windowDirs` Map による dir ↔ window の対応。ウィンドウごとに個別の RPC インスタンスを作成）
- CLI との Unix ドメインソケット通信（`orkis open`, `orkis hook`）
- PTY のライフサイクル管理（spawn, write, resize, kill, exit 通知）
- ファイル監視とツリー更新
- Git status の取得と変更通知
- 外部 URL のオープン（`Utils.openExternal` + プロトコルバリデーション）
- アプリ終了時の全 PTY クリーンアップ（`process.on("beforeExit")` 等で対応）

## 削除対象

- `apps/electron/` ディレクトリ全体
- `packages/preload/` ディレクトリ全体
- `scripts/watch.ts`（Electron 用の dev サーバー統合）
- ルート `package.json` の `electron` devDependency
- `pnpm-workspace.yaml` の `electron`, `node-pty`, `@parcel/watcher` の allowBuilds と catalog

## 設定ファイルの変更

### pnpm-workspace.yaml

- `allowBuilds` から `electron`, `node-pty`, `@parcel/watcher` を削除
- `catalog` から `electron` を削除
- `catalog` に `electrobun` を追加

### ルート package.json

- `scripts.start` を更新（`electron apps/electron` → `pnpm --filter @orkis/desktop start`）
- `scripts.dev` を更新（`bun scripts/watch.ts` → `pnpm --filter @orkis/desktop dev`）
- `devDependencies` から `electron` を削除

### apps/renderer/package.json

- `dependencies` に `electrobun` を追加（`electrobun/view` 用）
- `dependencies` に `@orkis/rpc` を追加
- `devDependencies` から `@orkis/preload` を削除
- `tsconfig.json` の `types` から `@orkis/preload` を削除

## 未検証事項と Go/No-Go 基準

| 未検証事項                                                                                                                                        | Go/No-Go 基準                                     | 失敗時の代替策                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| `electrobun/view` を Vite でバンドルしたときの動作（`window.__electrobunWebviewId` 等のグローバル変数が Electrobun ランタイムから注入される前提） | RPC の初期化と request/send が動作すること        | Vite の `define` で変数を注入、または external 化   |
| ghostty-web の WASM が Electrobun の WebView（WKWebView）で動作するか                                                                             | WASM のロードとターミナル描画が正常に行われること | xterm.js にフォールバック                           |
| pnpm モノレポでの `electrobun` CLI の動作（`pnpm exec electrobun dev`）                                                                           | dev/build コマンドが正常に実行できること          | `apps/desktop` 内で直接 `bunx electrobun` を実行    |
| `Bun.spawn` の `terminal.resize()` の有無                                                                                                         | PTY のリサイズが正常に動作すること                | SIGWINCH シグナルで対応、または Bun の issue で確認 |
| Electrobun にシングルインスタンス制御 API があるか                                                                                                | 2 つ目のプロセスを検知して終了できること          | ソケットの存在チェックまたは PID ファイルで自前実装 |
