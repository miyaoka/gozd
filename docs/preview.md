# Preview

ファイラーで選択したファイルの内容をプレビュー表示する。ファイル種別に応じたレンダリングと、git 変更ファイルの diff/original 表示を提供する。

## 構成

```
features/preview/
├── PreviewPane.vue           # ルートペイン（ファイル種別判定、モード切替、データ取得）
├── CodePreview.vue           # コード表示（Shiki ハイライト + 行番号）
├── DiffPreview.vue           # diff 表示（行単位の差分色分け、2列行番号）
├── ImagePreview.vue          # 画像表示
├── MarkdownPreview.vue       # Markdown レンダリング（marked + DOMPurify）
├── ChangesSummaryView.vue    # 全変更ファイルを縦並びで diff 表示するビュー
├── ChangesSummaryItem.vue    # summary view の 1 ファイル分のブロック
└── useHighlight.ts           # Shiki ハイライタの遅延初期化と言語検出
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

`useFsWatchSync` は全 worktree を watch するため、`fsChange.dir` が active dir と一致する event のみ反応する（[architecture.md の SSOT push の dir filter 規律](architecture.md#ssot-push-の-dir-filter-規律)）。親ディレクトリの照合では worktree 直下ファイルの relDir を native 側の `""` 表現に揃え、root file の通知を取りこぼさないようにしている。

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

- 表示モードは `split` (default) / `unified` の 2 つ。`viewMode` は preview セッション内 local state（永続化しない）
- diff 計算の SSOT は git。`rpcGitDiffHunks` で original / current を Swift に送り、`git diff --no-index` を経由した hunk 配列 + 総行数を受け取って描画する
  - renderer 側で jsdiff の全文 LCS を回すと `pnpm-lock.yaml` のような数万行ファイルで O(N×M) でメインスレッドが固まる。git の C 実装 (xdiff) に処理を委ねる
  - Swift 側は `NSTemporaryDirectory()` に 2 ファイル書き出し → `git -c diff.algorithm=myers -c diff.renames=false -c core.autocrlf=false -c core.eol=lf diff --no-index --no-color -U3` → unified diff を `DiffHunk[]` に parse。algorithm / 改行扱いはユーザー global config に依存しないよう `-c` で固定
  - 総行数 (`oldTotalLines` / `newTotalLines`) も response に含めて返す。renderer は `text.split("\n")` を独自に回さない (git の line counting 規約と分かれて trailing バーの表示行数がずれるため)
  - hunk 間 / ファイル先頭・末尾の連続 unchanged 行は「N unchanged lines」バーで省略表示する。バーは `oldStart` / `newStart` (1-based) と `lines` を保持し、クリックで `rpcGitDiffExpandLines` を呼んで Swift 側 `countDiffLines` と同じ line counting 規約で切り出した行ペアを取得 → `expansions` Map にキャッシュ。`oldGap === newGap` は unified diff の invariant なので shape を 1 本の `lines` に統合してある
  - 失敗時は `Failed to compute diff: <message>` を pane に表示する (トーストだけだと閉じた後に状態を追えない)
- 入力契約: `original` / `current` は UTF-8 として解釈可能なテキスト。バイナリは PreviewPane の `isBinary` 判定で弾く前提。万一 NUL バイトがすり抜けた場合は Swift 側で `Binary files ... differ` を検出して `unexpectedOutput` (exit 0 で正常終了したが stdout フォーマットが想定外、を意味する case) で観察可能化する
- Shiki の `codeToTokens()` で original / current それぞれのトークン配列を取得し、diff の各行に対応するトークンの色を適用
  - unified: removed 行 → original のトークン、added / unchanged 行 → current のトークン
  - split: 左セル → original のトークン、右セル → current のトークン
  - diff の色分けは背景色のみ。テキスト色はトークンに委ねる
  - 言語未対応時はフォールバック表示（追加=緑、削除=赤）
- unified と split の両方の表示形式を取得時に事前展開して保持。view mode 切替で再 fetch は走らない
- split view では modified hunk 内で連続する removed run と added run を貪欲ペアリングし、余った片側は反対セルを空 (灰色背景) にして残す

### MarkdownPreview

- `marked` で HTML に変換後、`DOMPurify.sanitize()` で XSS 対策
- YAML frontmatter を `hooks.preprocess` でコードブロックに変換して表示
- markdown 中の `[text](https://...)` 由来 `<a>` は、native の `ExternalLinkNavigationDecider`（[architecture.md](architecture.md) の「WebPage の navigation policy」参照）が拾って OS のデフォルトブラウザで開く。WebView 内で main frame が外部 URL に置換されることはない

### ImagePreview

- `<img>` タグでファイルサーバー URL を表示
- `object-contain` で縦横比を維持

## Preview チェックボックス

SVG / Markdown / 画像ファイルで、レンダリング結果とソースコードを切り替える。diff モードでは非表示。デフォルトは有効（プレビュー表示）。

## Changes summary view

ChangesPane ヘッダーの `View all` ボタンで preview ペインを「全変更ファイルの diff を縦並びで表示するモード」に切り替える。GitHub PR の Files changed タブ相当。

- データソースは `useChangesStore.fileChanges`（ChangesPane の樹状ビューと同じ SSOT）。uncommitted / 単一コミット / 範囲選択のいずれの選択状態にも追従する
- 1 ファイル = 1 ブロック。各ブロックはヘッダー（アイコン + パス + 変更種別バッジ + 折りたたみトグル）と `DiffPreview` の組み合わせ
- split / unified 切替と word wrap は summary 全体で 1 つのツールバーに統合される。`DiffPreview` の `externalViewMode` prop で個別ファイルのトグルバーは非表示にする
- Filer や ChangesPane のファイル行をクリックすると `worktreeStore.selectPath` が発火する。PreviewPane は `revealVersion` (selectPath で +1 されるカウンタ) を watch して summary を disable し、単一ファイル表示に戻る。git-graph 上の commit / range 切替では summary は維持される
- worktree 切替 (`worktreeStore.dir` 変化) でも summary は自動で disable される。Filer 選択が clear されるのと対称
- summary view 内の Close button は summary を disable しつつ popover も閉じる。次回 popover を開いた時は単一ファイル表示に戻る
- summary 表示中に ChangesPane の `View all` を再押下すると summary は disable される。popover は開いたまま、PreviewPane が単一ファイル表示にフォールバックする (selectedPath があればその diff、なければ "Select a file to preview" placeholder)。popover の close は伴わない
- per-item の fetch 失敗は item ブロック内に赤テキストで表示しつつ、ChangesSummaryView が `fetch-failed` emit を 100ms debounce で集約し「Failed to load N changes in summary」の `notification.error` を 1 件だけ出す。N 件 fan-out で toast が大量化するのを避ける契約
- summary view のフェッチ経路は PreviewPane の単一ファイル版と同じ規約に従う。uncommitted は `gitShowFile` + `fsReadFile`、コミットモードは `gitShowCommitFile` を per-item で実行する
- 状態の SSOT は `useChangesSummaryStore.enabled`。MainLayout はこのフラグを watch し、有効化時に preview popover を自動オープンする
