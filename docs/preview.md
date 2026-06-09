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
└── useHighlight.ts           # Shiki shorthand 呼び出し + 拡張子 → BundledLanguage 検出 (override 層)
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

「ファイル選択 → preview を開く / 閉じる」の意思決定は `usePreviewStore` の API に集約する。各 entry point は intent に応じて `requestSelect` / `forceSelect` を呼び分け、watch chain で暗黙に発火させない。

### entry point × intent 決定表

| entry point                                    | 呼ぶ API                   | 同一 path 再選択時の挙動  |
| ---------------------------------------------- | -------------------------- | ------------------------- |
| Filer ファイル行クリック                       | `requestSelect`            | preview を close          |
| Changes ファイル行クリック                     | `requestSelect`            | preview を close          |
| Terminal 出力中のファイルパス shift+click      | `requestSelect`            | preview を close          |
| CLI `gozd <file>` (gozdOpen push)              | `forceSelect`              | preview を維持（再 open） |
| MarkdownPreview 内部リンク click               | `forceSelect`              | preview を維持（再 open） |
| MarkdownPreview back / forward                 | `forceSelect`              | preview を維持（再 open） |
| ChangesPane `View all` ボタン                  | `toggleSummary`            | -                         |
| PreviewPane summary `Close` ボタン             | `close`                    | -                         |
| Preview 開閉ボタン / `preview.toggle` コマンド | `toggle`                   | 開閉反転                  |
| ESC キー                                       | `close`                    | -                         |
| Preview ヘッダの close ボタン                  | `close`                    | -                         |
| worktree 切替 (dir 変化)                       | `close` (副作用 watch)     | -                         |
| 表示中ファイルが消える (再 fetch で notFound)  | `closeForMissingSelection` | -                         |

`close()` は invariant として「popover 閉 ⇒ summary 解除」を担う。ESC / Preview ヘッダ close ボタン / dir 切替 / summary `Close` ボタンはすべてこの 1 つの経路に集約され、summary enabled=true + popover closed の整合性破綻状態は構造的に発生しない。

`requestSelect` の例外: 同一 path 再選択時に Changes summary が表示中なら `summaryStore.disable()` を単独で呼び、popover は閉じず単一 file 表示に戻る。これは `close()` invariant とは別経路で、PreviewPane のファイル選択 watch (`PreviewPane.vue` の `selectedDisplayPath` watch) と同じ「summary を抜けて単一 file 表示にフォールバック (popover 維持)」セマンティクスを共有する。

### その他の挙動

- worktree 切替 (dir 変化) で自動クローズ。dir watch は `usePreviewStore` 内部に閉じ込めてあり、MainLayout や外部経路から発火を観測する必要はない。新 worktree でファイル選択を伴う dir 切替 (`gozdOpen` で別 worktree のファイルを指定した経路等) では、続けて `forceSelect` で再 open されるため最終状態は新ファイルで表示継続になる。dir watch は `flush: 'sync'` で `gozdOpen` handler の `setOpen → forceSelect` 連続呼びと順序が崩れないようにする
- 外側クリックでは閉じない
- ESC キーで閉じる。ただし他の popover (BlamePopover 等) や dialog (SettingsModal 等) が前面にあるときはそれらが優先され、すべて閉じた次の ESC で preview が閉じる
- IME 変換中の ESC（変換キャンセル）では閉じない
- 表示中ファイルが削除されると自動クローズ。`fsChange` 再 fetch で current (作業ツリー) が notFound になったとき、PreviewPane は HEAD (`gitShowFile`) の在否も確認し、**current / HEAD いずれにも無い** (= 未追跡ファイルの削除等で実体がどこにも残っていない) と確定した場合のみ `closeForMissingSelection()` を呼んで選択解除 + close する。単一ファイル削除・ディレクトリごとの削除のどちらも同じ経路で拾う
  - git 追跡下の削除ファイルは HEAD に内容が残り Original を閲覧できる (削除レビュー用途) ため閉じない。`fsChange` が `gitStatusChange` より先に届き `selectedGitChange` がまだ `deleted` に変わっていない race でも、HEAD 在否を直接読むことで誤クローズしない (git status の push 順に依存しない)
  - native (`fileReadResultFromGit`) は HEAD 不在も git 実行失敗も `notFound=true` に畳んで返すため、HEAD 不在は `gitShowFile` 応答の `notFound=true` で表現される。`gitShowFile` が transport/dispatch 層で失敗した (RPC 自体が reject した) ときのみ不在を確定できず閉じない (notFound 表示に倒す)
  - 単一ファイル削除も親ディレクトリごとの削除も同じ経路で拾えるのは、FSWatcher が `kFSEventStreamCreateFlagFileEvents` 付きで配下ファイル単位の削除イベントを出し、その relDir が選択ファイルの親 relDir と一致するため（`apps/native/Sources/GozdCore/FSWatcher.swift`）
  - close 判定の SSOT は純粋関数 `shouldCloseForMissingFile`（summary 表示中 / 絶対パス / current 在 のいずれかなら閉じない、を集約）。PreviewPane 側の if は HEAD 在否確定 RPC を無駄撃ちしないための前段ガード

## データ取得

`PreviewPane` が RPC 経由で desktop からファイル内容を取得する。

| RPC                  | 用途                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `fsReadFile`         | 現在のファイル内容（バイナリ判定）                                   |
| `fsReadFileAbsolute` | 絶対パスでのファイル読み取り（ワークスペース外）                     |
| `gitShowFile`        | `HEAD` 時点のファイル内容（Uncommitted モードの Original / Diff 用） |
| `gitShowCommitFile`  | コミット間のファイル内容（from/to を一括取得。コミットモードで使用） |

- 画像 / SVG: WKWebView が `file://` をブロックするため、native の `gozd-file://` URLSchemeHandler 経由で raw bytes を配信
  - `gozd-file://localhost/fs?dir=<absDir>&path=<relPath>&v=<n>` — 作業ツリーの実ファイル (`FSOps.readFileBytes`、`resolveSafe` で path traversal 防止)
  - `gozd-file://localhost/git?dir=<absDir>&path=<relPath>&v=<n>` — `git show HEAD:<path>` の出力 (Original タブ)
  - `?v=<n>` パラメータは `fsChange` 等の再 fetch トリガーで同一 URL を再読み込みさせるためのキャッシュバスト
  - proto を bytes 化せずに `<img>` 直配信に倒した理由: テキスト系は従来通り `gozd-rpc://` + UTF-8 string で扱い、画像 / SVG だけ別 scheme に分ける方が proto 全体への破壊変更を避けられる
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

- Shiki の shorthand `codeToHtml` / `codeToTokens` を直接呼ぶ。内部の `createSingletonShorthands` 経路で grammar が **on-demand load** される (公式 best-practice: [Shiki - Best Performance Practices](https://shiki.style/guide/best-performance))。`createHighlighter({ langs: [...] })` での eager init を避けることで「map に列挙した分だけ起動コストが乗る」問題を構造的に消す
- `github-dark` テーマ
- `ShikiTransformer` で各行に `data-line` 属性を付与し、行頭に line-no 要素を実 DOM 挿入する。挿入する要素は親から渡された `blameEnabled` で切り替え、true なら `<button data-line-no-btn>` (event delegation で blame 起動経路)、false なら `<span class="_line-no-static" aria-hidden="true">` (focusable を奪い keyboard 経路でも何も起きないことを構造で保証)。fallback markup も同じ `v-if` で button/span を切替え、疑似要素 `::before` 由来のクリック判定問題と silent dead button を両方避ける
- 言語検出: 拡張子 / ファイル名 → Shiki `BundledLanguage` に変換。マッピングは `@gozd/shiki-lang-map` (GitHub Linguist の `languages.yml` × Shiki bundled langs の交差を build 時 codegen) を SSOT として参照し、`useHighlight.ts` 内の `EXTENSION_OVERRIDES` / `FILENAME_OVERRIDES` で gozd 固有 policy (例: `.m → objective-c`) を上書きする
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
  - split: 左側 → original のトークン、右側 → current のトークン
  - diff の色分けは背景色のみ。テキスト色はトークンに委ねる
  - 言語未対応時はフォールバック表示（追加=緑、削除=赤）
- unified と split の両方の表示形式を取得時に事前展開して保持。view mode 切替で再 fetch は走らない
- split view では modified hunk 内で連続する removed run と added run を貪欲ペアリングし、余った片側は反対側の行を空 (`_split-filler` で灰色背景) にして残す
- レンダリング構造は **section ベース**。`renderRows` / `splitRenderRows` を hunk-bar 境界で section 化し、各 section を `contenteditable=true` の editing host にする。hunk-bar は section の外に sibling として置くため、Cmd+A の scope に入らず unchanged lines のラベルは clipboard に乗らない。split では section 内の左右半身がそれぞれ独立した host で、Cmd+A は focus が居る半身 1 つだけに閉じる
- Cmd+A の scope 制御は **focus が leaf 内に居るときの挙動** に限定される。focus がトグル / タブ / ヘッダボタン等の leaf 外要素に乗っているときの Cmd+A は WebKit が document scope に倒し、preview popover 外を含む document 全体のテキスト領域 (`user-select: none` で明示的に除外していないもの) が選択される。これは「Cmd+A を JS で intercept しない」「`user-select: none` を scope 制御に使わない」(WebKit の selectAll は user-select を honor しない) 方針から構造的に残る帰結。leaf 外 focus 時に preview 内に閉じたい場合はユーザーが leaf を 1 回クリックして focus を移す前提
- 各 diff 行は `display: block` + hanging indent (`padding-left` + 負 `text-indent`) で描画する。flex / grid 子の blockification が contenteditable コピー時に余計な `\n` を撒く問題を避けるため、行内は inline-block の line-no と inline の本文だけで構成する。これにより clipboard が「1 行 = 1 改行」になり、word-wrap モードでも折返し行が line-no 幅で indent 揃えされる
- split の左右行揃えは CSS subgrid で実現する。`_split-section` に `grid-template-rows: repeat(N, auto)` を style binding で渡し、両半身が `grid-template-rows: subgrid` で同じ N 個の row track を共有する。word-wrap で左右の折返し行数が違っても、行ごとに高い方に track が伸びて左 row j と右 row j が同じ親 track に置かれる
- 行番号 (old / new いずれも) は親から `blameEnabled` を受けたときだけ `<button>` として描画し、クリックで `lineNumberClick({ side, line, anchorEl })` を emit する。`side` は old → Original 側 rev、new → Current 側 rev で BlamePopover を起動するために使う ([BlamePopover セクション](#blamepopover) 参照)。`blameEnabled=false` のときは button ではなく `<span class="_line-no">` として描画し、focusable も hover / pointer cursor も持たない (silent dead button を作らない契約)。表示は CSS `::before` + `attr(data-line-no)` で行うため、行番号テキスト自体は DOM に存在せず clipboard 対象外。CodePreview と同じ規約

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

- 表示中ファイル / `gitGraphStore.selectedHash` / `compareHash` / `activeMode` / `summaryStore.enabled` のいずれかが変わると `useBlamePopover().close()` を発火し popover を閉じる (文脈乖離した popover を残さない)。`summaryStore.enabled` を含めるのは、summary view 切替で CodePreview / DiffPreview が unmount され anchor が detached になるため
- PreviewPane / ChangesSummaryItem の `fsChange` callback は `fetchContent()` / `runFetch()` の **前** に `useBlamePopover().closeIfActive(dir, relPath)` を発火する。content 更新で CodePreview の Shiki / fallback button や DiffPreview の line-no button が DOM 置換されると anchor が detached になるため、再描画と同フレームで popover を閉じる
- ChangesSummaryItem は `onUnmounted` で `closeIfActive(dir, displayPath)` を発火する。`orderedFileChanges` 更新で `v-for` re-key で item が消えるケースも anchor detach 経路として共通化
- `closeIfActive(dir, relPath)` は context が完全一致する場合のみ close する。他 owner の文脈にぶつけても no-op で安全
- Popover API の `toggle` イベントを受けて Esc / 外クリック dismiss も composable 側の state を clear する
- `open()` / `close()` は `activeVersion` をインクリメントし、進行中の blame / history RPC は await 復帰時に version 不一致なら結果を破棄する
- 進行中 blame は `blameInFlight = { version, promise }` で tuple 化して保持する。`loadHistory` は await 前に `myVersion = activeVersion` を capture し、`blameInFlight.version === myVersion` のときだけ自分 version の blame を await する。let の素 Promise 参照だと `open(B)` で `blamePromise` が reassign されても、待機中の loadHistory は古い (A の) 参照を引きずって別 version の blame を待ち続けるバグになる。tuple version 比較でこれを構造的に防ぐ

#### Swift 側の防御

- `rev` は `validateRev` で `空文字 / "HEAD" / hex hash + 末尾 ^ ~` のみ許可。`-` 始まりや空白文字は option 注入として reject
- `blameLine` は空文字 (working tree) を許容するが、`logLine` は空文字を `unexpectedOutput` で reject する。`logLine` の rev は呼び出し側が必ず blame した commit hash を起点として流す契約のため、空文字で HEAD 起点 walk に倒れると「blame した commit を含まない history」が返って意味契約が壊れる。proto 側も同じ契約 (`gitLogLine` メッセージのコメント参照)
- blame 対象ファイルは `git cat-file -s` (または fs stat) でサイズを先に測り、`BLAME_MAX_BLOB_BYTES` (2 MiB) を超えるなら `unexpectedOutput` で reject。`pnpm-lock.yaml` 級ファイル全体 walk による UI ブロックを防ぐ
- size 取得失敗の silent 通過は「予期された不在」経路のみ: working tree は `NSFileReadNoSuchFileError` のみ、`git cat-file` は `GitError.commandFailed` (exit 128 = path 未解決) のみ。`launchFailed` / `commandNotFound` / 数値 parse 失敗等は throw で観察可能化する (規約「fallback せずエラーにする」と整合)
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

#### 内部リンク遷移の履歴 (back / forward)

Markdown preview 内の内部リンククリックは back / forward 履歴に積まれる。ブラウザの「戻る / 進む」と同じモデルで、双方向スタックを保持する。

仕様契約:

- リンククリック時: 現在の selection を back スタックに積み、forward スタックを破棄する
- back / forward の操作はスタックの pop と「現在の selection を反対側に push」を 1 つの不変条件として実行する
- 同じパスかつ同じ行番号への再遷移は履歴に積まない（自己リンクや同一ファイル間の往復で重複が混入しないため）
- PreviewPane ヘッダに back / forward ボタンを常時描画する。履歴の有無で header の幅が揺れないよう、操作不能側は disabled で表現する
- キーバインドは preview popover が開いていてかつ入力欄にフォーカスが無い時だけ発火する。コマンドパレットからもラベル付きで実行できる

履歴のスコープ:

- 履歴に積まれるのは **MarkdownPreview の `<a>` クリック由来の遷移のみ**
- filer クリック / terminal リンク / プログラム的な selection 更新 / worktree 切替など、それ以外の経路で selection が変化した瞬間に両スタックを破棄する
- 「内部リンク経由か否か」の判定は、自前の navigate / goBack / goForward が selection を書き換える同期スコープ内で立てるフラグで行う。selection の変化を sync watch で観測し、フラグが立っていなければ外部経路とみなしてスタックをクリアする

履歴スタックの上限: **設けない**。md preview の navigate は人間が `<a>` をクリックする経路でのみ発生するため、現実的な操作頻度で memory pressure になる事象は観測されていない。本契約を変更する場合は本ファイルを SSOT として書き換え、実装側に隠れた cap を入れない。

実装識別子・型シグネチャ・watch flush タイミング等の内部詳細は `useMarkdownHistoryStore.ts` のヘッダコメントを参照。

### ImagePreview

- `<img>` タグでファイルサーバー URL を表示
- `object-contain` で縦横比を維持

## Preview チェックボックス

SVG / Markdown / 画像ファイルで、レンダリング結果とソースコードを切り替える。diff モードでは非表示。デフォルトは有効（プレビュー表示）。

## Changes summary view

ChangesPane の `View all` ボタンで preview ペインを「全変更ファイルの diff を縦並びで表示するモード」に切り替える。GitHub PR の Files changed タブ相当。

### スコープと追従

- 表示する変更ファイル一覧は Changes パネル (ファイルツリー) と同じ SSOT を共有する。uncommitted / 単一コミット / 範囲選択 / PR diff のいずれの選択状態にも追従し、ChangesPane と summary は常に同じファイル集合を見る
- worktree を切り替えると summary は自動で解除される (Filer 選択が clear されるのと対称)

### PR diff モード

ChangesPane ヘッダの `PR #<n>` toggle が ON のとき、summary を含む各 view は「**`merge-base(HEAD, pr.baseRefOid)` から working tree まで**」(GitHub Files changed と同じ 3-dot semantics) の diff に切り替わる。`baseRefOid` を直接起点にすると、PR 分岐後に base ブランチが前進した分が逆向きに差分として混入するため、必ず merge-base を取り直してから使う。詳細:

- 一覧は `rpcGitPrDiffFiles({ baseHash: mergeBaseOid })` (= `git diff <mergeBase>`、右辺省略 = working tree) + untracked を merge した形で `useChangesStore.orderedFileChanges` に乗る
- per-file diff は `rpcGitReadBlob`(from = merge-base の blob) + `rpcFsReadFile`(to = working tree) を並列取得して描画する
- toggle 経路の SSOT は `usePrDiffToggleStore`。`enable()` で reachable 判定 → 必要なら fetch → `rpcGitMergeBase(HEAD, baseRefOid)` の順に解決し、`lockedBase = { sourceBaseOid: baseRefOid snapshot, diffBaseOid: merge-base OID }` を snapshot する。consumer が読む公開 getter `lockedBaseOid` は `diffBaseOid` (= merge-base) を返す
- `gitGraphStore` の selection は触らず、`selectionVersion` の increment (= ユーザーが graph で commit を選んだ) で自動 OFF になる
- PR が見つからない / `baseRefOid` 未解決のときは toggle 自体が gate される (`canEnable === false`)
- base OID が local に reachable でないとき (未 fetch) は `useRemoteFetchStore.requestImmediateFetch` で 1 回自動 fetch する。merge-base 解決失敗 (unrelated histories 等) は `notify.error` を出して enable をキャンセル

### UI 構成

- 1 ファイル = 1 ブロック。ヘッダー (アイコン / パス / 変更種別バッジ / 折りたたみトグル) と diff 本体の組み合わせ
- 表示モード (split / unified) と word wrap はビュー全体で 1 つのツールバーに統合され、各 diff に共通で適用される。ファイル個別のトグルは出さない

### モード遷移

- Filer や ChangesPane でファイル行をクリックすると summary は解除され、単一ファイル表示に戻る
- git-graph 上で commit / range を切り替えても summary は維持される (上のスコープに従ってファイル集合が入れ替わる)
- summary 解除は `usePreviewStore.close` に集約される (上述の invariant)。ChangesPane の `View all` 再押下、summary 内 `Close` ボタン、ESC、Preview ヘッダ close ボタンはすべて同じ経路
- summary を有効化すると preview popover が自動で開く (`usePreviewStore.openSummary` で `summaryStore.enable` と popover open をペアで遷移)

### データ取得とリアクティブ更新

- 各ファイルの diff は単一ファイル view と同じ取得経路に従う (uncommitted は HEAD vs 作業ツリー、コミット / 範囲は git オブジェクトから)。差分は per-item に個別フェッチされる
- 大量変更でも初期描画を固めないため、各 item はビューポートに入って初めて diff をフェッチする (lazy 取得)
- uncommitted モードでは [単一ファイル view と同じ「リアクティブ更新」規律](#リアクティブ更新)に従い、ファイル中身が変われば diff が自動で hot-reload される。コミットモードでは fs 変更は無視する

### 失敗時の通知

- 個別ファイルの取得失敗は item ブロック内に赤テキストで表示される
- 複数ファイルの並列フェッチが同時に失敗するケースに備え、summary は失敗を debounce で集約し、固定メッセージのトースト 1 件にまとめる (バッチを跨いだ追加失敗も同じトーストに丸まる)。詳細件数と直近の原因はトーストの cause 詳細パネルに展開される
