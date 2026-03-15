# Terminal

ターミナルエミュレータ。Electrobun RPC 経由で desktop 側の PTY プロセスと通信する。
バックエンドとして xterm.js（デフォルト）と ghostty-web を UI から切り替えられる。

## 構成

```
features/terminal/
├── TerminalPane.vue              # 分割レイアウト管理（フラットレンダリング）
├── TerminalLeaf.vue              # リーフノード（バックエンド切り替え、フォーカス管理）
├── SplitResizeHandle.vue         # 分割リサイズハンドル（ドラッグ）
├── XtermTerminal.vue             # xterm.js バックエンド（デフォルト）
├── GhosttyTerminal.vue           # ghostty-web バックエンド
├── splitTree.ts                  # immutable な分割ツリー操作（split, remove, resize）
├── terminalConfig.ts             # 共通設定（フォント、テーマ）
├── registerTerminalCommands.ts   # 分割・ナビゲーションコマンドの登録
├── useTerminalStore.ts           # worktree ごとの分割レイアウト状態管理（Pinia）
├── useFilePathLinkProvider.ts    # ターミナル出力のファイルパス検出・クリック
├── useSplitResize.ts             # ratio ベースのリサイズ管理
└── useSpatialNavigation.ts       # leaf 間の矩形ベース空間ナビゲーション
```

## PTY ライフサイクル

```mermaid
sequenceDiagram
    participant R as TerminalPane (renderer)
    participant D as desktop (bun)
    participant P as PTY (shell)

    R->>D: ptySpawn({ dir, cols, rows })
    D->>P: Bun.spawn([shell], { terminal })
    D-->>R: PTY ID

    loop ユーザー操作
        R->>D: ptyWrite({ id, data })
        D->>P: proc.terminal.write(data)
    end

    loop PTY 出力
        P-->>D: terminal.data(data)
        D-->>R: ptyData({ id, data })
    end

    opt リサイズ
        R->>D: ptyResize({ id, cols, rows })
        D->>P: proc.terminal.resize(cols, rows)
    end

    R->>D: ptyKill({ id })
    D->>P: proc.kill()
    P-->>D: terminal.exit()
    D-->>R: ptyExit({ id, exitCode })
```

- shell: `process.env.SHELL` または `zsh`
- cwd: `ptySpawn` の `dir` パラメータ（worktree ごとに異なる）
- 環境変数: `FORCE_HYPERLINK=1` で CLI ツール（Claude Code 等）の OSC 8 ハイパーリンク出力を許可
- UTF-8 デコード: `TextDecoder({ stream: true })` でチャンク分割時のマルチバイト文字化けを防止

## ターミナル分割

バイナリツリー構造で水平・垂直分割を管理する。`splitTree.ts` が immutable なツリー操作を提供する。

```
splitNode（内部ノード）
├── direction: "horizontal" | "vertical"
├── ratio: 分割比率（0〜1）
├── left: SplitNode | LeafNode
└── right: SplitNode | LeafNode

leafNode
└── id: ターミナル ID
```

### フラットレンダリング

`TerminalPane` は `flattenTree()` でツリーを走査し、全 leaf と handle を `position: absolute` で配置する。ツリー変更時に leaf の DOM 再生成が発生しないため、xterm のバッファが維持される。

leaf の存在（ツリー構造）と rect（コンテナサイズ）を分離し、コンテナサイズ未確定時の 0x0 mount を防止する。

### 空間ナビゲーション

`useSpatialNavigation` が各 leaf の矩形位置（rect）から、指定方向の最近傍 leaf を算出する。非表示 worktree の leaf は候補から除外する。

### コマンド

| コマンド                   | 動作                                    |
| -------------------------- | --------------------------------------- |
| `terminal.splitHorizontal` | アクティブ leaf を水平分割              |
| `terminal.splitVertical`   | アクティブ leaf を垂直分割              |
| `terminal.closePane`       | アクティブ leaf を閉じる（PTY も kill） |
| `terminal.focusLeft`       | 左の leaf にフォーカス移動              |
| `terminal.focusRight`      | 右の leaf にフォーカス移動              |
| `terminal.focusUp`         | 上の leaf にフォーカス移動              |
| `terminal.focusDown`       | 下の leaf にフォーカス移動              |
| `terminal.togglePreview`   | プレビューペインの表示切替              |

## Worktree ごとのレイアウト保持

`useTerminalStore`（Pinia）が `layoutsByDir`（`Map<dir, TerminalLayoutState>`）で worktree ごとに分割レイアウトを保持する。

- `visit(dir)` で初回訪問時にレイアウトを作成し、PTY を起動する
- worktree 切り替え時は既存レイアウトを復元する（PTY プロセスと xterm バッファは維持される）
- worktree 削除時は該当 PTY を kill する

## ファイルパスリンク

`useFilePathLinkProvider` が xterm の LinkProvider を実装し、ターミナル出力のファイルパスをクリック可能にする。

- 相対パスと絶対パス（`~/` 展開含む）の両方に対応
- Claude Code が改行+インデントで折り返したパスも結合して検出
- クリック時にプレビューペインでファイルを表示

## バックエンド

| バックエンド | ライブラリ                      | リサイズ方式             | 備考                    |
| ------------ | ------------------------------- | ------------------------ | ----------------------- |
| xterm        | @xterm/xterm + @xterm/addon-fit | 手動 ResizeObserver      | 日本語入力が安定        |
| ghostty      | ghostty-web                     | FitAddon.observeResize() | WASM パーサーで高速描画 |

バックエンド切り替え時は PTY を再生成して新しいターミナルを開く。

## 共通設定（terminalConfig.ts）

- フォント: UDEV Gothic 35NF, Menlo, monospace（13px）
- テーマ: zinc 系ダークテーマ（背景 `#18181b`）
- カーソル: 点滅有効
- ANSI カラーは各バックエンドのデフォルトパレットを使用

## Desktop 側の PTY 管理

- `Map<number, PtyEntry>` で PTY ID → プロセスを管理
- `PtyEntry` は `win`, `worktreeDir`, `decoder` を保持
- ウィンドウ close 時に、そのウィンドウが所有する全 PTY を kill
- worktree 削除時は `worktreeDir` で該当 PTY を特定して kill
- `Bun.spawn({ terminal })` で PTY をネイティブサポート（node-pty 不要）
