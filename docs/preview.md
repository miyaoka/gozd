# Preview

ファイラーで選択したファイルの内容をプレビュー表示する。ファイル種別に応じたレンダリングと、git 変更ファイルの diff/original 表示を提供する。

## 構成

```
features/preview/
├── PreviewPane.vue       # ルートペイン（ファイル種別判定、モード切替、データ取得）
├── CodePreview.vue       # コード表示（Shiki ハイライト + 行番号）
├── DiffPreview.vue       # diff 表示（行単位の差分色分け、2列行番号）
├── ImagePreview.vue      # 画像表示
├── MarkdownPreview.vue   # Markdown レンダリング（marked + mermaid）
└── useHighlight.ts       # Shiki ハイライタの遅延初期化と言語検出
```

## ファイル種別

拡張子から判定する。マッチしないものは `code` として扱う。

| 種別     | 拡張子                                    | レンダリング                                              |
| -------- | ----------------------------------------- | --------------------------------------------------------- |
| image    | png, jpg, jpeg, gif, webp, avif, ico, bmp | `<img>` (ファイルサーバー URL)                            |
| svg      | svg                                       | 画像プレビュー（ファイルサーバー URL） / ソースコード切替 |
| markdown | md                                        | marked + mermaid + DOMPurify                              |
| code     | その他すべて                              | Shiki シンタックスハイライト                              |
| binary   | NUL バイト含有                            | 「Binary file」メッセージ                                 |

## モード切替

git 変更ファイルには Original / Diff / Current の3タブを表示する。タブ順序は時系列（過去 → 現在）。

| 変更種別                 | 利用可能なモード        | デフォルト |
| ------------------------ | ----------------------- | ---------- |
| 変更なし                 | Current                 | Current    |
| modified, added, renamed | Original, Diff, Current | Diff       |
| deleted                  | Original                | Original   |
| untracked                | Current                 | Current    |

## 開閉機能

プレビューペインは右端に配置され、開閉可能。デフォルトは closed。

- ファイル選択時に自動オープン
- ヘッダーの close ボタンで閉じる
- `terminal.togglePreview` コマンドで切り替え

## データ取得

`PreviewPane` が RPC 経由で desktop からファイル内容を取得する。

| RPC                  | 用途                                             |
| -------------------- | ------------------------------------------------ |
| `fsReadFile`         | 現在のファイル内容（バイナリ判定）               |
| `fsReadFileAbsolute` | 絶対パスでのファイル読み取り（ワークスペース外） |
| `gitShowFile`        | `HEAD` 時点のファイル内容（Original / Diff 用）  |

- 画像 / SVG: WKWebView が `file://` をブロックするため、desktop 側のファイルサーバー経由で配信
  - `/fs/{relPath}` — 現在のファイル
  - `/git/{relPath}` — HEAD 時点のファイル
  - `?v=<version>` パラメータで画像キャッシュバスト
- 絶対パスの場合は git 操作（`gitShowFile`）を呼ばない
- バイナリ判定: NUL バイト（`0x00`）の有無で判定（git と同じ方式）
- 最大サイズ: 1MB を超えるファイルはバイナリ扱い

## リアクティブ更新

### git status 変化時

`selectedGitChange` は `useWorkspaceStore` の computed から取得する。`gitStatuses` が更新されると自動再計算され、`PreviewPane` の watch がトリガーされてモード・タブをリセットしつつ再取得する。

### ファイル内容変更時

desktop からの `fsChange` メッセージを購読し、選択中ファイルの親ディレクトリが変更対象なら `fetchContent()` を再実行する。モードや Preview チェックボックスの状態は維持する。

### 非同期レース防止

バージョンカウンター（`fetchVersion`）で管理する。`fetchContent()` 呼び出し時にインクリメントし、レスポンス到着時にバージョンが一致しなければ結果を破棄する。

## 各サブコンポーネント

### CodePreview

- Shiki の `createHighlighter` で遅延初期化（シングルトン）
- `github-dark` テーマ
- `ShikiTransformer` で各行に `data-line` 属性を付与し、CSS `::before` で行番号表示
- 言語検出: 拡張子 → `EXTENSION_LANG_MAP` で Shiki 言語 ID に変換
- word-wrap トグルボタンでコードの折り返しを切り替え

### DiffPreview

- `diff` パッケージ（jsdiff）の `diffLines()` で行単位差分を算出
- 全行を表示し、追加行は緑、削除行は赤、変更なしはデフォルト色
- 2列の行番号（旧ファイル / 新ファイル）を flex レイアウトで表示

### MarkdownPreview

- `marked` で HTML に変換後、`DOMPurify.sanitize()` で XSS 対策
- YAML frontmatter を `hooks.preprocess` でコードブロックに変換して表示
- mermaid コードブロックを検出し、`mermaid.render()` でダイアグラムに変換
- ダークテーマ対応（`mermaid.initialize({ theme: "dark" })`）

### ImagePreview

- `<img>` タグでファイルサーバー URL を表示
- `object-contain` で縦横比を維持

## Preview チェックボックス

SVG / Markdown / 画像ファイルで、レンダリング結果とソースコードを切り替える。diff モードでは非表示。デフォルトは有効（プレビュー表示）。
