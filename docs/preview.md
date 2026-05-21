# Preview

ファイラーで選択したファイルの内容をプレビュー表示する。ファイル種別に応じたレンダリングと、git 変更ファイルの diff/original 表示を提供する。

## 構成

```
features/preview/
├── PreviewPane.vue           # ルートペイン（ファイル種別判定、モード切替、データ取得）
├── CodePreview.vue           # コード表示（Shiki ハイライト + 行番号）
├── DiffPreview.vue           # diff 表示（行単位の差分色分け、2列行番号）
├── BlamePopover.vue          # 行番号クリックで開く blame / line history popover
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
- `ShikiTransformer` で各行に `data-line` 属性を付与し、行頭に `<button data-line-no-btn>` を実 DOM 挿入（疑似要素 `::before` ではなくクリックターゲットにできる button にして event delegation で blame 起動経路に流す）
- 言語検出: 拡張子 → `EXTENSION_LANG_MAP` で Shiki 言語 ID に変換
- word-wrap トグルボタンでコードの折り返しを切り替え
- 行番号指定時（`:行番号` サフィックス付きリンクから）は該当行にスクロールし、黄色背景でハイライト
- 行番号 button クリックで `lineNumberClick` イベントを emit（PreviewPane が BlamePopover に橋渡し）

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
- 行番号セル (old / new いずれも) は親から `blameEnabled` を受けたときだけ button 化され、クリックで `lineNumberClick({ side, line, anchorEl })` を emit する。`side` は old → Original 側 rev、new → Current 側 rev で BlamePopover を起動するために使う ([BlamePopover セクション](#blamepopover) 参照)。`blameEnabled=false` のときは button ではなく静的な数字セルとして描画し、hover / pointer cursor も出ない (silent dead button を作らない契約)

### BlamePopover

行番号クリックで開く blame / line history popover。HTML Popover API (`popover="auto"`) と CSS Anchor Positioning (`top: anchor(bottom)`) を使い、Esc / 外クリックでの dismiss と viewport flip をブラウザに委譲する (SidebarMenu と同じパターン)。

#### 起動経路 (composable)

open / close / state は `useBlamePopover` (module singleton) が SSOT。`defineExpose` で親から子の内部メソッドを呼ぶ設計禁止規約 (apps/renderer/CLAUDE.md) に従い、`BlamePopover.vue` は state を購読して描画するだけで操作は composable に集約する。PreviewPane と ChangesSummaryItem は `useBlamePopover().open(anchorEl, ctx)` を呼ぶ。`BlamePopover` は MainLayout に 1 度だけ mount する。

#### rev の決定ルール

| 経路                                           | rev                          |
| ---------------------------------------------- | ---------------------------- |
| Uncommitted モードの Current                   | `""` (空文字 = working tree) |
| Uncommitted モードの Original                  | `"HEAD"`                     |
| コミットモードの Current (newer = 実 hash)     | `<newer hash>`               |
| コミットモードの Current (newer = WorkingTree) | `""`                         |
| コミットモードの Original (単一 commit 選択)   | `<newer>^`                   |
| コミットモードの Original (範囲選択)           | `<older>^`                   |
| Diff モード (clicked side = old)               | Original 側の rev            |
| Diff モード (clicked side = new)               | Current 側の rev             |

Diff モードでは `lineNumberClick` payload の `side: "old" | "new"` で行が属する側を判定する。片側だけの add/remove 行は反対側に行番号がなく button も描画されないので、clicked side は常に存在する側だけ。

#### 2 ステート

- **Blame**: `rpcGitBlameLine` を 1 行に絞って呼び (`git blame --porcelain -L N,N [<rev>] -- <relPath>`)、commit hash / author / 相対日付 / summary を表示。working tree の未コミット行は sha が全 0 で返るため `notCommitted` フラグで "Not committed yet" 表記に倒す
- **History**: `rpcGitLogLine` で `git log -L<n>,<n>:<relPath> --no-patch <hash>` を呼び、その行を変更してきた commit 一覧を新しい順で表示。click で `gitGraphStore.select(hash)` を呼んで git-graph 側の選択にも反映しつつ popover を閉じる

History は blame 完了を必ず待ってから走る。起点 commit は blame が返す `commit.hash` に固定し、起点行番号は blame の `source_line` を使う。`ctx.rev` を起点に渡すと、Original (`<older>^`) などで「blame した commit を含まない history」が返って意味契約が壊れるため。blame error / cancel 時は history も error に倒す (loading 中の表示行 fallback は廃止)。`notCommitted` 行 (working tree のみ) は history を実行しても空になるため History タブを disable し説明文を出す。

#### 状態同期と race

- 表示中ファイル / `gitGraphStore.selectedHash` / `compareHash` / `activeMode` のいずれかが変わると `useBlamePopover().close()` を発火し popover を閉じる (文脈乖離した popover を残さない)
- Popover API の `toggle` イベントを受けて Esc / 外クリック dismiss も composable 側の state を clear する
- `open()` / `close()` は `activeVersion` をインクリメントし、進行中の blame / history RPC は await 復帰時に version 不一致なら結果を破棄する。同一 popover 内で blame と history の race も同じ counter で揃える

#### Swift 側の防御

- `rev` は `validateRev` で 空文字 / `HEAD` / hex hash + 末尾 `^` `~` のみ許可。`-` 始まりや空白文字は option 注入として reject
- blame 対象ファイルは `git cat-file -s` (または fs stat) でサイズを先に測り、`BLAME_MAX_BLOB_BYTES` (2 MiB) を超えるなら `unexpectedOutput` で reject。`pnpm-lock.yaml` 級ファイル全体 walk による UI ブロックを防ぐ
- `git log -L` は path に `:` を含むと syntax が壊れるため、`logLine` 側で reject する
- `git blame --porcelain` の parse は各行を trim してから処理し、CRLF 等の trailing whitespace で `author-time` 等の数値 parse が silent に 0 へ倒れるのを防ぐ

#### スコープ外

- 絶対パスで開いたファイル (filer の "open external" 経由) は git 管理外として、CodePreview / DiffPreview / ChangesSummaryItem 側で `blameEnabled=false` を渡して button 描画自体を抑止する (popover は起動しない)
- 単一行のみ。範囲選択 (multi-line) はスコープ外

### MarkdownPreview

- Markdown を HTML に変換して描画する。HTML はサニタイズして XSS を防ぐ
- YAML frontmatter はコードブロックとして描画する

#### リンクの遷移先ルール

Markdown 内のリンクは href の形式によって遷移先が決まる。リンク経路の役割分担は [architecture.md](architecture.md) の「WebPage の navigation policy」と整合する。

| href の形式                                                                      | 遷移先                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `http(s)://` / `mailto:`                                                         | OS のデフォルトブラウザで開く（外部ナビゲーション）                                  |
| `#fragment` 単独                                                                 | 同一文書内のアンカーへスクロール                                                     |
| `/` 始まり                                                                       | worktree ルートからの相対パスとしてプレビュー対象を切り替える                        |
| `./` / `../` / 名前のみ                                                          | 現在表示中の Markdown ファイルのディレクトリ基準で結合してプレビュー対象を切り替える |
| 行番号フラグメント (`./foo.ts#L42` 等)                                           | path 部分でファイル切替、行番号は CodePreview の行ハイライト/スクロールに反映        |
| その他 scheme (`gozd-rpc:` / `gozd-app:` / `file:` / `data:` / `javascript:` 等) | 無視（信頼境界外として遷移しない）                                                   |

#### 例外条件と通知

- worktree ルートの外を指すリンク (`../` で抜ける等) と不正な URL エンコードは通知のみでファイル切替を行わない
- 行番号でない anchor (見出しアンカー等) はファイル切替は行うが、見出しスクロールは行わず通知で挙動を明示する（自動スクロールは未対応）
- 修飾子付きクリック / 中ボタンクリック等の特殊操作はブラウザ既定挙動に委ねる
- 通知は href ごとに別メッセージを出さず、固定 message と詳細 cause に分けて重複抑制を効かせる

実装の詳細（クリック捕捉経路、解決ロジック、行番号フラグメントの抽出規則、URL デコードの取り扱い）は `MarkdownPreview.vue` の `<doc>` ブロックと `resolveMarkdownLink` を参照。

### ImagePreview

- `<img>` タグでファイルサーバー URL を表示
- `object-contain` で縦横比を維持

## Preview チェックボックス

SVG / Markdown / 画像ファイルで、レンダリング結果とソースコードを切り替える。diff モードでは非表示。デフォルトは有効（プレビュー表示）。

## Changes summary view

ChangesPane の `View all` ボタンで preview ペインを「全変更ファイルの diff を縦並びで表示するモード」に切り替える。GitHub PR の Files changed タブ相当。

### スコープと追従

- 表示する変更ファイル一覧は Changes パネル (ファイルツリー) と同じ SSOT を共有する。uncommitted / 単一コミット / 範囲選択のいずれの選択状態にも追従し、ChangesPane と summary は常に同じファイル集合を見る
- worktree を切り替えると summary は自動で解除される (Filer 選択が clear されるのと対称)

### UI 構成

- 1 ファイル = 1 ブロック。ヘッダー (アイコン / パス / 変更種別バッジ / 折りたたみトグル) と diff 本体の組み合わせ
- 表示モード (split / unified) と word wrap はビュー全体で 1 つのツールバーに統合され、各 diff に共通で適用される。ファイル個別のトグルは出さない

### モード遷移

- Filer や ChangesPane でファイル行をクリックすると summary は解除され、単一ファイル表示に戻る
- git-graph 上で commit / range を切り替えても summary は維持される (上のスコープに従ってファイル集合が入れ替わる)
- ChangesPane の `View all` を再押下すると summary は解除される。popover は閉じず、単一ファイル表示にフォールバックする (選択中ファイルがあればその diff、無ければ placeholder)
- summary 内の Close ボタンは summary を解除しつつ popover も閉じる
- summary を有効化すると preview popover が自動で開く

### データ取得とリアクティブ更新

- 各ファイルの diff は単一ファイル view と同じ取得経路に従う (uncommitted は HEAD vs 作業ツリー、コミット / 範囲は git オブジェクトから)。差分は per-item に個別フェッチされる
- 大量変更でも初期描画を固めないため、各 item はビューポートに入って初めて diff をフェッチする (lazy 取得)
- uncommitted モードでは [単一ファイル view と同じ「リアクティブ更新」規律](#リアクティブ更新)に従い、ファイル中身が変われば diff が自動で hot-reload される。コミットモードでは fs 変更は無視する

### 失敗時の通知

- 個別ファイルの取得失敗は item ブロック内に赤テキストで表示される
- 複数ファイルの並列フェッチが同時に失敗するケースに備え、summary は失敗を debounce で集約し、固定メッセージのトースト 1 件にまとめる (バッチを跨いだ追加失敗も同じトーストに丸まる)。詳細件数と直近の原因はトーストの cause 詳細パネルに展開される
