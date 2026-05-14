# Preview

ファイラーで選択したファイルの内容をプレビュー表示する。ファイル種別に応じたレンダリングと、git 変更ファイルの diff/original 表示を提供する。

## 構成

```
features/preview/
├── PreviewPane.vue       # ルートペイン（ファイル種別判定、モード切替、データ取得）
├── CodePreview.vue       # コード表示（Shiki ハイライト + 行番号）
├── DiffPreview.vue       # diff 表示（行単位の差分色分け、2列行番号）
├── ImagePreview.vue      # 画像表示
├── MarkdownPreview.vue   # Markdown レンダリング（marked + DOMPurify）
└── useHighlight.ts       # Shiki ハイライタの遅延初期化と言語検出
```

## ファイル種別

拡張子から判定する。マッチしないものは `code` として扱う。

| 種別     | 拡張子                                    | レンダリング                                              |
| -------- | ----------------------------------------- | --------------------------------------------------------- |
| image    | png, jpg, jpeg, gif, webp, avif, ico, bmp | `<img>` (ファイルサーバー URL)                            |
| svg      | svg                                       | 画像プレビュー（ファイルサーバー URL） / ソースコード切替 |
| markdown | md                                        | marked + DOMPurify                                        |
| code     | その他すべて                              | Shiki シンタックスハイライト                              |
| binary   | NUL バイト含有                            | 「Binary file」メッセージ                                 |

## モード切替

git 変更ファイルには Original / Diff / Current の3タブを表示する。タブ順序は時系列（過去 → 現在）。

### Uncommitted モード（デフォルト）

| 変更種別                 | 利用可能なモード        | デフォルト |
| ------------------------ | ----------------------- | ---------- |
| 変更なし                 | Current                 | Current    |
| modified, added, renamed | Original, Diff, Current | Current    |
| deleted                  | Original                | Original   |
| untracked                | Current                 | Current    |

### コミットモード（git-graph でコミット選択時）

変更種別は `gitShowCommitFile` の from/to 結果から導出する。from/to の解決方法は以下:

- 単一コミット選択: from = `<hash>^`, to = `<hash>`
- 範囲選択: from = `<older>^`, to = `<newer>`（older / newer はクリック順ではなく `commits` 配列の index で時系列順に整列）
- 端点に Working Tree を含む範囲選択: renderer 側で分岐し、to は `fsReadFile`、from は `gitShowCommitFile(hash=<older>, compareHash="")` の `from` 結果（= `<older>^`）を流用する。`UNCOMMITTED_HASH` sentinel は RPC 境界を越えず wire 上は常に実 git hash のみ流れる

`GitOps.commitFiles` のファイル一覧 (`<older>^ vs <newer>`) と endpoint を揃えてあるため、Changes パネルのファイル一覧と Preview の diff が常に一致する。

| 変更種別                                     | 利用可能なモード               | デフォルト |
| -------------------------------------------- | ------------------------------ | ---------- |
| modified（from/to 両方あり + OID 差分あり）  | Original, Diff, Current        | Diff       |
| 変更なし（from/to 両方あり + blob OID 同一） | Current                        | Current    |
| added（from なし、to あり）                  | Current                        | Current    |
| deleted（from あり、to なし）                | Original                       | Original   |
| 両方 not found                               | Current（File not found 表示） | Current    |

「変更なし」判定は Filer 経由でコミット範囲外のファイルを選択したケースを救済する。Changes 経由では差分のあるファイルしかリストされないため発生しない。判定の SSOT は `gitShowCommitFile` 応答の `unchanged` フィールド（Swift 側で `git rev-parse <hash>:<path>` の blob OID 比較から導出）に置き、renderer 内のテキスト比較は行わない。Working Tree 端を含む範囲選択は OID が無いため `unchanged=false` で扱う。

### Original タブの hash 表示

タブラベルは `Original (<hash>)` 形式で、実際に from として読んでいる ref を可視化する。Swift 側の `fromHash` 算出式と一致する。

| 選択状態           | 表示        |
| ------------------ | ----------- |
| Uncommitted モード | `HEAD`      |
| 単一コミット       | `<hash7>^`  |
| 範囲選択           | `<older7>^` |

## 開閉機能

プレビューペインは右端に配置され、開閉可能。デフォルトは closed。

- ファイル選択時に自動オープン
- ヘッダーの close ボタンで閉じる
- `terminal.togglePreview` コマンドで切り替え

## データ取得

`PreviewPane` が RPC 経由で desktop からファイル内容を取得する。

| RPC                  | 用途                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `fsReadFile`         | 現在のファイル内容（バイナリ判定）                                   |
| `fsReadFileAbsolute` | 絶対パスでのファイル読み取り（ワークスペース外）                     |
| `gitShowFile`        | `HEAD` 時点のファイル内容（Uncommitted モードの Original / Diff 用） |
| `gitShowCommitFile`  | コミット間のファイル内容（from/to を一括取得。コミットモードで使用） |

- 画像 / SVG: WKWebView が `file://` をブロックするため、desktop 側のファイルサーバー経由で配信
  - `/fs/{relPath}` — 現在のファイル
  - `/git/{relPath}` — HEAD 時点のファイル
  - `?v=<version>` パラメータで画像キャッシュバスト
- 絶対パスの場合は git 操作（`gitShowFile`）を呼ばない
- バイナリ判定: NUL バイト（`0x00`）の有無で判定（git と同じ方式）
- 最大サイズ: 1MB を超えるファイルはバイナリ扱い

## リアクティブ更新

### git status 変化時（Uncommitted モードのみ）

`selectedGitChange` は `useWorktreeStore` の computed から取得する。`gitStatuses` が更新されると自動再計算され、`PreviewPane` の watch がトリガーされてモード・タブをリセットしつつ再取得する。

### コミット選択変化時

`useGitGraphStore` の `selectedHash` / `compareHash` を watch し、コミット選択が変わると `fetchCommitContent()` で再取得する。

### ファイル内容変更時（Uncommitted モードのみ）

desktop からの `fsChange` メッセージを購読し、選択中ファイルの親ディレクトリが変更対象なら `fetchContent()` を再実行する。モードや Preview チェックボックスの状態は維持する。コミットモードでは git オブジェクトからの取得済み内容を表示するため、ファイル変更通知は無視する。

### 非同期レース防止

バージョンカウンター（`fetchVersion`）で管理する。`fetchContent()` 呼び出し時にインクリメントし、レスポンス到着時にバージョンが一致しなければ結果を破棄する。

## 各サブコンポーネント

### CodePreview

- Shiki の `createHighlighter` で遅延初期化（シングルトン）
- `github-dark` テーマ
- `ShikiTransformer` で各行に `data-line` 属性を付与し、CSS `::before` で行番号表示
- 言語検出: 拡張子 → `EXTENSION_LANG_MAP` で Shiki 言語 ID に変換
- word-wrap トグルボタンでコードの折り返しを切り替え
- 行番号指定時（`:行番号` サフィックス付きリンクから）は該当行にスクロールし、黄色背景でハイライト

### DiffPreview

- `diff` パッケージ（jsdiff）の `diffLines()` で行単位差分を算出
- Shiki の `codeToTokens()` で original / current それぞれのトークン配列を取得し、diff の各行に対応するトークンの色を適用
  - removed 行 → original のトークン、added / unchanged 行 → current のトークン
  - diff の色分けは背景色のみ。テキスト色はトークンに委ねる
  - 言語未対応時はフォールバック表示（追加=緑、削除=赤）
- 2列の行番号（旧ファイル / 新ファイル）を flex レイアウトで表示

### MarkdownPreview

- `marked` で HTML に変換後、`DOMPurify.sanitize()` で XSS 対策
- YAML frontmatter を `hooks.preprocess` でコードブロックに変換して表示

### ImagePreview

- `<img>` タグでファイルサーバー URL を表示
- `object-contain` で縦横比を維持

## Preview チェックボックス

SVG / Markdown / 画像ファイルで、レンダリング結果とソースコードを切り替える。diff モードでは非表示。デフォルトは有効（プレビュー表示）。
