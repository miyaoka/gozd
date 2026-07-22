# Preview

ファイラーで選択したファイルの内容をプレビュー表示する。ファイル種別に応じたレンダリングと、git 変更ファイルの diff/original 表示を提供する。

## レイヤー構成

単一ファイル view の責務は PreviewPane (leaf 切替) を頂点に 3 つの composable 層へ分かれる。

- `usePreviewContent`: データ取得と表示状態の状態機械（uncommitted / commit / PR diff の 3 取得経路、非同期レース防止、fsChange 再取得、モード導出）
- `usePreviewRevs`: blame / file history の rev 導出と popover 連携
- `usePreviewEdit`: 編集の可否判定と Edit / Save / Discard 操作

markdown レンダリング・blame / file history popover・changes summary は `features/preview/features/` 配下の子 feature (`markdown` / `commit-history` / `changes-summary`) として preview から独立している。

## ファイル種別

拡張子から判定する。マッチしないものは `code` として扱う。

| 種別     | 拡張子                                    | レンダリング                                                                     |
| -------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| image    | png, jpg, jpeg, gif, webp, avif, ico, bmp | `<img>` (ファイルサーバー URL)                                                   |
| svg      | svg                                       | 画像プレビュー（ファイルサーバー URL） / ソースコード切替                        |
| markdown | md                                        | marked + DOMPurify                                                               |
| html     | html, htm                                 | sandboxed `<iframe srcdoc>` でネイティブ描画 / ソース切替                        |
| code     | その他すべて                              | Monaco Editor + Shiki TextMate ハイライト（編集可否は[編集機能](#編集機能)参照） |

NUL バイトを含むファイルは拡張子ベースの種別判定に依らず、内容ベースの binary 判定（`displayIsBinary`）で「Binary file」メッセージ表示に倒す。

HTML の Preview トグルは **デフォルト OFF（ソース表示）**。他のレンダリング種別（markdown / svg / image）はデフォルト ON だが、HTML は「ソースを読む」用途が主なため向きを反転させる。デフォルトの向きは `defaultPreviewEnabled`、トグル可否は `hasRenderedView` と別関数に分離する（`previewFileType.ts`）。

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

「変更なし」判定は Filer 経由でコミット範囲外のファイルを選択したケースを救済する。Changes 経由では差分のあるファイルしかリストされないため発生しない。判定の SSOT は `gitShowCommitFile` 応答の `unchanged` フィールド（main 側で `git rev-parse <hash>:<path>` の blob OID 比較から導出）に置き、renderer 内のテキスト比較は行わない。Working Tree 端を含む範囲選択は OID が無いため `unchanged=false` で扱う。

### Original タブの hash 表示

タブラベルは `Original (<hash>)` 形式で、実際に from として読んでいる ref を可視化する。main 側の `fromHash` 算出式と一致する。

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
| File picker（Go to File / Cmd+P）で選択        | `forceSelect`              | preview を維持（再 open） |
| MarkdownPreview 内部リンク click               | `forceSelect`              | preview を維持（再 open） |
| MarkdownPreview back / forward                 | `forceSelect`              | preview を維持（再 open） |
| Session log dialog の生ログを開くボタン        | `forceSelect`              | preview を維持（再 open） |
| Settings modal の設定ファイルを開くボタン      | `forceSelect`              | preview を維持（再 open） |
| ChangesPane `View all` ボタン                  | `toggleSummary`            | -                         |
| PreviewPane summary `Close` ボタン             | `close`                    | -                         |
| Preview 開閉ボタン / `preview.toggle` コマンド | `toggle`                   | 開閉反転                  |
| ESC キー                                       | `close`                    | -                         |
| Preview ヘッダの close ボタン                  | `close`                    | -                         |
| worktree 切替 (dir 変化)                       | `close` (副作用 watch)     | -                         |
| 表示中ファイルが消える (再 fetch で notFound)  | `closeForMissingSelection` | -                         |

`close()` は invariant として「popover 閉 ⇒ summary 解除」を担う。ESC / Preview ヘッダ close ボタン / dir 切替 / summary `Close` ボタンはすべてこの 1 つの経路に集約され、summary enabled=true + popover closed の整合性破綻状態は構造的に発生しない。

`requestSelect` / `forceSelect` は selection が成立しない入力を no-op に倒す（空 popover を作らない契約）。worktreeRelative は dir 未確立時に弾かれるが、absolute（worktree 外の絶対パス）は dir 文脈を必要としないため repo 未選択でも開ける（session log の生ログ preview が該当）。

`requestSelect` の例外: 同一 path 再選択時に Changes summary が表示中なら `summaryStore.disable()` を単独で呼び、popover は閉じず単一 file 表示に戻る。これは `close()` invariant とは別経路で、PreviewPane のファイル選択 watch (`PreviewPane.vue` の `selectedDisplayPath` watch) と同じ「summary を抜けて単一 file 表示にフォールバック (popover 維持)」セマンティクスを共有する。

### その他の挙動

- worktree 切替 (dir 変化) で自動クローズ。dir watch は `usePreviewStore` 内部に閉じ込めてあり、MainLayout や外部経路から発火を観測する必要はない。新 worktree でファイル選択を伴う dir 切替 (`gozdOpen` で別 worktree のファイルを指定した経路等) では、続けて `forceSelect` で再 open されるため最終状態は新ファイルで表示継続になる。dir watch は `flush: 'sync'` で `gozdOpen` handler の `setOpen → forceSelect` 連続呼びと順序が崩れないようにする
- 外側クリックでは閉じない
- ESC キーで閉じる。ただし他の popover (BlamePopover 等) や dialog (SettingsModal 等) が前面にあるときはそれらが優先され、すべて閉じた次の ESC で preview が閉じる
- IME 変換中の ESC（変換キャンセル）では閉じない
- 表示中ファイルが削除されると自動クローズ。`fsChange` 再 fetch で current (作業ツリー) が notFound になったとき、content 取得層 (`usePreviewContent`) は HEAD (`gitShowFile`) の在否も確認し、**current / HEAD いずれにも無い** (= 未追跡ファイルの削除等で実体がどこにも残っていない) と確定した場合のみ `closeForMissingSelection()` を呼んで選択解除 + close する。単一ファイル削除・ディレクトリごとの削除のどちらも同じ経路で拾う
  - git 追跡下の削除ファイルは HEAD に内容が残り Original を閲覧できる (削除レビュー用途) ため閉じない。`fsChange` が `gitStatusChange` より先に届き `selectedGitChange` がまだ `deleted` に変わっていない race でも、HEAD 在否を直接読むことで誤クローズしない (git status の push 順に依存しない)
  - native (`fileReadResultFromGit`) は HEAD 不在も git 実行失敗も `notFound=true` に畳んで返すため、HEAD 不在は `gitShowFile` 応答の `notFound=true` で表現される。`gitShowFile` が transport/dispatch 層で失敗した (RPC 自体が reject した) ときのみ不在を確定できず閉じない (notFound 表示に倒す)
  - 単一ファイル削除も親ディレクトリごとの削除も同じ経路で拾えるのは、@parcel/watcher が配下ファイル単位の削除イベントを出し、その relDir が選択ファイルの親 relDir と一致するため（`apps/electron/src/fs/fsWatchRegistry.ts`）
  - close 判定の SSOT は純粋関数 `shouldCloseForMissingFile`（summary 表示中 / 絶対パス / current 在 のいずれかなら閉じない、を集約）。`usePreviewContent` 側の if は HEAD 在否確定 RPC を無駄撃ちしないための前段ガード

### ファイル操作メニュー（⋮）

ヘッダの ⋮ ボタンで Open in default app / Copy file / Copy path のメニューを開く。項目と
アクションは Filer / Changes の右クリックメニューと共通の `FileActionMenuItems`（filer feature）を
共有する（popover instance は `usePopover` の「menu の種類ごとに独立」規律に従い共有しない）。
Copy file / Copy path の意味論は [filer.md](filer.md#ファイルコピーos-クリップボード) を参照。

Open in default app は表示中ファイルを OS のデフォルトアプリ（macOS の `open` 相当）で開く。

- 対象は常に **working tree の実ファイル**。commit / PR diff モードで履歴版を表示中でも、開くのはディスク上の実体（git 履歴の内容ではない）。表示用の `selectedDisplayPath` は RPC 入力に使わない契約のため流用しない
- RPC は専用の `/open/file`（`rpcOpenFile`）。native は `NSWorkspace.shared.open(URL(fileURLWithPath:))`。`openExternal`（`/open/external`）は OSC 8 リンク経由の任意 scheme 流入への防壁として scheme allowlist（http/https/mailto）で `file://` を弾くため、ローカルファイルを開く intent は別 RPC に分離する
- 実パスの解決と描画 gate は純関数 `resolveOpenablePath`（テスト付き）が SSOT。working tree に実体があるときだけ selection の kind から実パスを解決し（`worktreeRelative` は `joinAbsRel(dir, relPath)`、`absolute` は `absPath` 直）、実体が無いケース（selection 無し / `isNotFound` / commit・PR diff モードで `deleted` 版を表示中）は undefined を返す。`openableAbsPath` がこれに委譲し、template の `v-if` がそのまま ⋮ ボタン描画を gate するため、押せるが native の存在チェックで必ず失敗する silent dead button を作らない（`blameEnabled` の added file gate と同じ規律）
- **相対→絶対の解決は基準ディレクトリ（worktree root）を持つ renderer の責務**。`/open/file` には常に解決済みの絶対パスが渡る契約で、native は基準ディレクトリを持たず解決を**再実装しない**（再実装すると契約の SSOT が二重化する）。この契約は `OpenFileRequest.path`（`@gozd/rpc`）のコメントと main handler に明記する
- ただし native は入口で**非絶対パス（空文字含む）を `invalidArgument` で弾く**。これは解決（基準ディレクトリ依存）ではなく、`URL(fileURLWithPath:)` が空文字・相対パスを CWD 基準で silent に絶対化する Foundation の暗黙 fallback を塞ぐためのガード。特に空文字は `url.path` が CWD になり `fileExists` も true を返すため、`NSWorkspace.open` が Finder で CWD を黙って開く誤動作になる。`fallback せずエラーにする` 規律に従い明示エラーへ倒す
- native の `fileExists` は契約検証ではなく、上記描画 gate を抜けた race（表示直後に実体が消えた等）向けの safety net。不在なら `invalidArgument` で弾き（無言 no-op を避ける）、renderer 側は失敗を `useNotificationStore` のトーストで通知する。アクセス制御の関所ではない

## データ取得

`usePreviewContent` が RPC 経由で desktop からファイル内容を取得する。

| RPC                  | 用途                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `fsReadFile`         | 現在のファイル内容（バイナリ判定）                                                          |
| `fsReadFileAbsolute` | 絶対パスでのファイル読み取り（ワークスペース外）                                            |
| `gitShowFile`        | `HEAD` 時点のファイル内容（Uncommitted モードの Original / Diff 用）                        |
| `gitShowCommitFile`  | コミット間のファイル内容（from/to を一括取得。コミットモードで使用）                        |
| `gitLogFile`         | ファイル全体の commit 履歴（`git log -- <path>`。ヘッダのコミット日 + file history で使用） |

- 画像 / SVG: 専用経路を持たず、テキストと同じ read RPC で取得した content から表示する。
  content はテキスト / バイナリを型で区別して運び（ワイヤ契約の SSOT は `@gozd/rpc` の
  `FileReadResult`）、表示はデータ取得層の意味論（live の再取得 / undocked snapshot の固定）を
  そのまま反映する。URL 再読込やキャッシュバストは存在せず、Original タブも各取得経路が
  実際に参照した rev の内容が映る
- worktree 外の絶対パスは git 操作を呼ばず、fs 読み単独で読み切る（画像 / SVG も同じ）
- rename (move) されたファイルの Original / Diff: `gitStatuses` のキーは新パスのみ持つため、status と同一 snapshot で届く `renameOldPaths`（新パス → 旧パス、`useGitStatusStore` が SSOT）で HEAD 側のパスを解決してから `gitShowFile` を引く。旧パス解決を欠くと HEAD 側が notFound になり「全行追加」の diff に倒れる。uncommitted モードの HEAD 側 blame（`rev === "HEAD"`）も同じ map で旧パスに揃える
- バイナリ判定は main 側の read 実装が行い、content の型で表現する（フラグは持たない。判定条件はコード側が SSOT）

## リアクティブ更新

### git status 変化時（Uncommitted モードのみ）

`selectedGitChange` は `useWorktreeStore` の computed から取得する。`gitStatuses` が更新されると自動再計算され、`usePreviewContent` の watch がトリガーされて再取得する。**タブ（activeMode）はリセットしない**: 対象切替でない再発火（自分の save で unmodified → modified になった等）でデフォルトモードへ倒すと、Current で編集保存した瞬間に diff タブへ勝手に切り替わってしまう。ユーザーの選んだタブを維持し、gitChange の変化で現在タブが成立しなくなったとき（外部 checkout で diff が消える等）だけデフォルトへ倒す（`applyActiveMode`）。タブのリセットはファイル選択・コミット選択・PR diff トグルの切替時のみ。

### コミット選択変化時

`useGitGraphStore` の `selectedHash` / `compareHash` を watch し、コミット選択が変わると `fetchCommitContent()` で再取得する。

### ファイル内容変更時（Uncommitted モードのみ）

desktop からの `fsChange` メッセージを購読し、選択中ファイルの親ディレクトリが変更対象なら `fetchContent()` を再実行する。モードや Preview チェックボックスの状態は維持する。コミットモードでは git オブジェクトからの取得済み内容を表示するため、ファイル変更通知は無視する。

worktree 外の絶対パス選択は fsWatchRegistry の対象外で `fsChange` が届かないため、表示している間だけ main に単一ファイル watch（`rpcFsWatchFileAbsolute` → `absFileWatcher`）を張り、`fsChangeAbsolute` push で再取得する（設定 JSON / session log 等。VS Code が開いているファイルを個別 watch するのと同じ形）。モード維持の規律は `fsChange` と同じ。dirty 中の変更イベントは捨てずに保留し、編集終了（Discard / Save / セッション終了）で isDirty が落ちた時点で再取得する — 捨てると Discard 後に外部変更前の stale な内容へ巻き戻り、そのまま保存で外部変更を上書きしてしまうため。選択が外れたら unwatch する（main 側は path ごとの refcount で undocked window と共有）。

`useFsWatchSync` は全 worktree を watch するため、`fsChange.dir` が active dir と一致する event のみ反応する（[architecture.md の SSOT push の dir filter 規律](architecture.md#ssot-push-の-dir-filter-規律)）。親ディレクトリの照合では worktree 直下ファイルの relDir を native 側の `""` 表現に揃え、root file の通知を取りこぼさないようにしている。

### 非同期レース防止

バージョンカウンター（`fetchVersion`）で管理する。`fetchContent()` 呼び出し時にインクリメントし、レスポンス到着時にバージョンが一致しなければ結果を破棄する。

## 各サブコンポーネント

### CodePreview

- Monaco Editor で表示・編集する。エディタ標準の検索 (Cmd+F find widget) と仮想スクロールをそのまま使う。編集可否は `editable` prop（[編集機能](#編集機能) 参照）で切り替え、単一コンポーネントの `updateOptions` 切替なのでタブ切替で remount されない
- ハイライトは Monaco 標準の Monarch ではなく、`@shikijs/monaco` で Shiki の TextMate grammar を `monaco.languages.setTokensProvider` に接ぎ込む (`monacoSetup.ts` の `resolveMonacoLanguage`)。Monarch が対応しない言語 (Vue 等) もハイライトでき、Monaco 組み込み言語も VS Code 品質 (`tokenizeLine2`。VS Code 本体と同じ呼び口) に揃う
- grammar は **on-demand load** (`getSingletonHighlighter`。DiffPreview の `codeToTokens` shorthand と同じ singleton を共有)。新しい言語を開いたときだけ `shikiToMonaco` を呼び直して provider を再配線する
- `github-dark` テーマ (`useHighlight.ts` の `SHIKI_THEME` が SSOT。`shikiToMonaco` が同名の Monaco テーマを defineTheme する)
- 言語検出: 拡張子 / ファイル名 → Shiki `BundledLanguage` に変換。マッピングは `@gozd/shiki-lang-map` (GitHub Linguist の `languages.yml` × Shiki bundled langs の交差を build 時 codegen) を SSOT として参照し、`useHighlight.ts` 内の `EXTENSION_OVERRIDES` / `FILENAME_OVERRIDES` で gozd 固有 policy (例: `.m → objective-c`) を上書きする。Shiki 未対応の言語は Monaco 組み込みの言語メタデータへ fallback する
- word-wrap トグルは Monaco の `wordWrap` オプションに反映
- 行番号指定時（`:行番号` サフィックス付きリンクから）は `revealLineInCenter` + whole-line decoration で該当行にスクロール・ハイライト
- `blameEnabled` のとき gutter (行番号) クリック、または context menu / command palette の "Show Blame for Line" action（keyboard 経路）で `lineNumberClick` イベントを emit（`usePreviewRevs` が BlamePopover に橋渡し）。トリガー判定は `monacoSetup.ts` の `wireGutterBlame` に集約する（VS Code folding と同じ mousedown 記録 → mouseup 検証。popover light dismiss との位相、pointer capture により native click / Monaco 内部 DOM anchor が使えない理由は同 docstring が SSOT）。popover anchor はコンポーネント所有の不可視要素を幾何 API で対象行の gutter 位置に重ねて使い、位置は起動時固定のためスクロールで `scrolled` を emit し PreviewPane が blame popover を閉じる。末尾改行直後の空の最終行（Monaco が描画する phantom 行。git の行数に存在しない）は blame 対象外

### DiffPreview

- 表示モードは `split` (default) / `unified` の 2 つ。`viewMode` は preview セッション内 local state（永続化しない）
- diff 計算の SSOT は git。`rpcGitDiffHunks` で original / current を main に送り、`git diff --no-index` を経由した hunk 配列 + 総行数を受け取って描画する
  - renderer 側で jsdiff の全文 LCS を回すと `pnpm-lock.yaml` のような数万行ファイルで O(N×M) でメインスレッドが固まる。git の C 実装 (xdiff) に処理を委ねる
  - main 側 (`gitDiff.ts`) は tmpdir に 2 ファイル書き出し → `git -c diff.algorithm=myers -c diff.renames=false -c core.autocrlf=false -c core.eol=lf diff --no-index --no-color -U3` → unified diff を `DiffHunk[]` に parse。algorithm / 改行扱いはユーザー global config に依存しないよう `-c` で固定
  - 総行数 (`oldTotalLines` / `newTotalLines`) も response に含めて返す。renderer は `text.split("\n")` を独自に回さない (git の line counting 規約と分かれて trailing バーの表示行数がずれるため)
  - hunk 間 / ファイル先頭・末尾の連続 unchanged 行は「N unchanged lines」バーで省略表示する。バーは `oldStart` / `newStart` (1-based) と `lines` を保持し、クリックで `rpcGitDiffExpandLines` を呼んで main 側 `countDiffLines` と同じ line counting 規約で切り出した行ペアを取得 → `expansions` Map にキャッシュ。`oldGap === newGap` は unified diff の invariant なので shape を 1 本の `lines` に統合してある
  - 失敗時は `Failed to compute diff: <message>` を pane に表示する (トーストだけだと閉じた後に状態を追えない)
- 入力契約: `original` / `current` は UTF-8 として解釈可能なテキスト。バイナリは PreviewPane の `isBinary` 判定で弾く前提。万一 NUL バイトがすり抜けた場合は main 側で `Binary files ... differ` を検出して `unexpectedOutput` (exit 0 で正常終了したが stdout フォーマットが想定外、を意味する case) で観察可能化する
- Shiki の `codeToTokens()` で original / current それぞれのトークン配列を取得し、diff の各行に対応するトークンの色を適用
  - unified: removed 行 → original のトークン、added / unchanged 行 → current のトークン
  - split: 左側 → original のトークン、右側 → current のトークン
  - diff の色分けは背景色のみ。テキスト色はトークンに委ねる
  - 言語未対応時はフォールバック表示（追加=緑、削除=赤）
- 行内 (文字単位) ハイライト: 変更ブロック (removed run × added run) の内側を monaco-editor deep import の VSCode `DefaultLinesDiffComputer` で文字単位に再計算する
  - 行単位 diff の SSOT は git のまま。行内は表示専用の追加レイヤーで、hunk 構造と矛盾しない。VSCode のノイズ抑制ヒューリスティック (単語境界への拡張、細切れ一致の除去) がそのまま効く
  - トーン設計は VSCode の line/char decoration 二層と同型。行背景は従来の diff 色 (`<intent>-subtle`、step 3)、行内変更範囲は 1 段明るい `<intent>-subtle-emphasis` (step 5) を重ねる。沈む側 (step 2 以下) での差別化は dark パレットの低 step 圧縮で知覚不能のため不採用。純粋な追加 / 削除行と degrade した run (予算切れ / timeout) は従来通り行全体 subtle
  - メインスレッド同期実行のため 1 ファイル合算の時間予算で打ち切り、超過分は行単位表示に degrade する (エラーにしない。VSCode と同じ戦略)
- unified と split の両方の表示形式を取得時に事前展開して保持。view mode 切替で再 fetch は走らない
- split view では modified hunk 内で連続する removed run と added run を貪欲ペアリングし、余った片側は反対側の行を空 (`_split-filler` で灰色背景) にして残す
- レンダリング構造は **section ベース**。`renderRows` / `splitRenderRows` を hunk-bar 境界で section 化し、各 section を `contenteditable=true` の editing host にする。hunk-bar は section の外に sibling として置くため、Cmd+A の scope に入らず unchanged lines のラベルは clipboard に乗らない。split では section 内の左右半身がそれぞれ独立した host で、Cmd+A は focus が居る半身 1 つだけに閉じる
- Cmd+A の scope 制御は **focus が leaf 内に居るときの挙動** に限定される。focus がトグル / タブ / ヘッダボタン等の leaf 外要素に乗っているときの Cmd+A はブラウザが document scope に倒し、preview popover 外を含む document 全体のテキスト領域 (`user-select: none` で明示的に除外していないもの) が選択される。これは「Cmd+A を JS で intercept しない」「`user-select: none` を scope 制御に使わない」(selectAll は user-select を honor しない — WebKit shell 期に検証) 方針から構造的に残る帰結。leaf 外 focus 時に preview 内に閉じたい場合はユーザーが leaf を 1 回クリックして focus を移す前提
- 各 diff 行は `display: block` + hanging indent (`padding-left` + 負 `text-indent`) で描画する。flex / grid 子の blockification が contenteditable コピー時に余計な `\n` を撒く問題を避けるため、行内は inline-block の line-no と inline の本文だけで構成する。これにより clipboard が「1 行 = 1 改行」になり、word-wrap モードでも折返し行が line-no 幅で indent 揃えされる
- split の左右行揃えは CSS subgrid で実現する。`_split-section` に `grid-template-rows: repeat(N, auto)` を style binding で渡し、両半身が `grid-template-rows: subgrid` で同じ N 個の row track を共有する。word-wrap で左右の折返し行数が違っても、行ごとに高い方に track が伸びて左 row j と右 row j が同じ親 track に置かれる
- split の左右幅は `grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)` で常に 50/50 に固定する。`1fr` (= `minmax(auto, 1fr)`) は auto 側の automatic minimum が nowrap の長い行の min-content を拾い、左右がコンテンツ量比で割れてしまうため、min を 0 にしたトラックで等分する。半身単位の overflow box は持たず、50% を越える長い行は `overflow: visible` で枠を越えて描画され、diff 全体を囲む `_diff-scroll` (overflow-auto) の横スクロールで参照する
- 行番号 (old / new いずれも) は親から `blameEnabled` を受けたときだけ `<button>` として描画し、クリックで `lineNumberClick({ side, line, anchorEl })` を emit する。`side` は old → Original 側 rev、new → Current 側 rev で BlamePopover を起動するために使う ([BlamePopover セクション](#blamepopover) 参照)。`blameEnabled=false` のときは button ではなく `<span class="_line-no">` として描画し、focusable も hover / pointer cursor も持たない (silent dead button を作らない契約)。表示は CSS `::before` + `attr(data-line-no)` で行うため、行番号テキスト自体は DOM に存在せず clipboard 対象外。CodePreview と同じ規約

### BlamePopover

行番号クリックで開く blame / line history popover。HTML Popover API (`popover="auto"`) と CSS Anchor Positioning を使い、Esc / 外クリックでの dismiss と viewport flip をブラウザに委譲する。popover の anchor 付け替え・light-dismiss・toggle race は共通抽象 `shared/popover/usePopover` に委譲し (useTaskMenu / useWorktreeMenu 等と同パターン)、`useBlamePopover` は blame / line history の RPC race だけを所有する。

#### 起動経路 (composable)

open / close / state は `useBlamePopover` (module singleton) が SSOT。`defineExpose` で親から子の内部メソッドを呼ぶ設計禁止規約 (apps/renderer/CLAUDE.md) に従い、`BlamePopover.vue` は `usePopover` の `Popover` コンポーネント + state を購読して描画するだけで操作は composable に集約する。`usePreviewRevs` と ChangesSummaryItem は `useBlamePopover().open(anchorEl, ctx)` を呼ぶ。`BlamePopover` は MainLayout に 1 度だけ mount する。

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
- `usePreviewContent` (fsChange の `onBeforeRefetch` hook) / ChangesSummaryItem の `fsChange` callback は `fetchContent()` / `runFetch()` の **前** に `useBlamePopover().closeIfActive(dir, relPath)` を発火する。content 更新で CodePreview の Monaco gutter や DiffPreview の line-no button が DOM 置換されると anchor が detached になるため、再描画と同フレームで popover を閉じる
- CodePreview (Monaco) のスクロールは `scrolled` emit 経由で PreviewPane が blame popover を閉じる。blame anchor はクリック時の位置に固定した自前要素のため、スクロールすると行とずれた位置を指し続ける (DiffPreview の read-only 表示は全行実 DOM なので anchor がスクロールに追従し、この経路は不要)
- draft 変更 (タイピング) でも popover を閉じる。blame は保存済み working tree に対して走るため、行の増減で blame 行と表示行が乖離した popover を残さない
- ChangesSummaryItem は `onUnmounted` で `closeIfActive(dir, displayPath)` を発火する。`orderedFileChanges` 更新で `v-for` re-key で item が消えるケースも anchor detach 経路として共通化
- `closeIfActive(dir, relPath)` は context が完全一致する場合のみ close する。他 owner の文脈にぶつけても no-op で安全
- popover の close (Esc / 外クリック light-dismiss 含む) は `usePopover` の `context` が undefined になる経路に集約され、`useBlamePopover` はその watch で進行中 RPC を破棄し state を初期化する
- `open()` / `close()` は `activeVersion` をインクリメントし、進行中の blame / history RPC は await 復帰時に version 不一致なら結果を破棄する
- 進行中 blame は `blameInFlight = { version, promise }` で tuple 化して保持する。`loadHistory` は await 前に `myVersion = activeVersion` を capture し、`blameInFlight.version === myVersion` のときだけ自分 version の blame を await する。let の素 Promise 参照だと `open(B)` で `blamePromise` が reassign されても、待機中の loadHistory は古い (A の) 参照を引きずって別 version の blame を待ち続けるバグになる。tuple version 比較でこれを構造的に防ぐ

#### main 側の防御

- `rev` は `validateRev` で `空文字 / "HEAD" / hex hash + 末尾 ^ ~` のみ許可。`-` 始まりや空白文字は option 注入として reject
- `blameLine` は空文字 (working tree) を許容するが、`logLine` は空文字を `unexpectedOutput` で reject する。`logLine` の rev は呼び出し側が必ず blame した commit hash を起点として流す契約のため、空文字で HEAD 起点 walk に倒れると「blame した commit を含まない history」が返って意味契約が壊れる。`@gozd/rpc` 側も同じ契約 (`GitLogLineRequest` のコメント参照)
- blame 対象ファイルは `git cat-file -s` (または fs stat) でサイズを先に測り、`BLAME_MAX_BLOB_BYTES` (2 MiB) を超えるなら `unexpectedOutput` で reject。`pnpm-lock.yaml` 級ファイル全体 walk による UI ブロックを防ぐ
- size 取得失敗の silent 通過は「予期された不在」経路のみ: working tree はファイル不在 (ENOENT) のみ、`git cat-file` は commandFailed (exit 128 = path 未解決) のみ。spawn 失敗 / 数値 parse 失敗等は throw で観察可能化する (規約「fallback せずエラーにする」と整合)
- `git log -L` は path に `:` を含むと syntax が壊れるため、`logLine` 側で reject する
- `git blame --porcelain` の parse は各行を trim してから処理し、CRLF 等の trailing whitespace で `author-time` 等の数値 parse が silent に 0 へ倒れるのを防ぐ

#### スコープ外

- 非 git project、および絶対パスで開いたファイル (filer の "open external" 経由) は git 管理外として、CodePreview / DiffPreview / ChangesSummaryItem 側で `blameEnabled=false` を渡して button 描画自体を抑止する (popover は起動しない)
- 単一行のみ。範囲選択 (multi-line) はスコープ外

### FileCommitDate / FileHistoryPopover

BlamePopover が **行単位** (`git blame` / `git log -L`) なのに対し、こちらは **ファイル単位** (`git log -- <path>`)。preview ヘッダにファイルの最終コミット日を常時表示し、クリックでファイル全体の commit 履歴 popover を開く。一覧 commit のクリックで `gitGraphStore.select(hash)` する挙動は行 history と同じ。

行単位の `useBlamePopover` とは別経路 (`useFileHistoryPopover`、module singleton) で、blame ステップを持たず history 一本の state だけを管理する。BlamePopover と同じく popover 機構は `shared/popover/usePopover` に委譲し (`Popover` コンポーネント + `context`)、composable は RPC race (`activeVersion` で await 復帰時に破棄) だけを所有する。commit 行のマークアップ (shortHash バッジ / 相対日付 / クリック) は `CommitHistoryList.vue` に切り出し、行 history (BlamePopover) とファイル history (FileHistoryPopover) で共有する。`rev → modeLabel` 変換は `revModeLabel.ts` を usePreviewRevs / ChangesSummaryItem / FileCommitDate で共有する。

#### rev の決定ルール

ヘッダのコミット日 / file history の起点 rev は **表示中タブに追従** する (`usePreviewRevs` の `historyRev`)。

| 表示タブ       | rev                                 |
| -------------- | ----------------------------------- |
| Original       | `originalRev` (`HEAD` / `<older>^`) |
| Current / Diff | `currentRev` (`""` / `<newer>`)     |

`gitLogFile` は `gitLogLine` (行) と違い **空文字 rev を許容** する (空文字 = HEAD walk = ファイルの最新コミット起点)。blame-anchored 契約がファイル history には無いため。Diff タブは単一 rev を持たないため Current 側 rev を代表に使う。

#### 表示 gate とリアクティブ更新

- `fileHistoryEnabled`: git repo (`selectedIsGitRepo`) かつ selection が `worktreeRelative` かつ `historyRev` 解決済み、かつディレクトリでないときだけ日付を表示する (非 git project / 絶対パス / orderedRange 不整合 / ディレクトリを除外、`blameEnabled` が content 領域描画でディレクトリに出ないのと挙動を揃え silent dead button を作らない)
- props (`dir` / `relPath` / `rev`) 変化で `git log -1` を再 fetch (ファイル切替 / タブ・commit 選択切替に追従)。race は version counter で破棄
- HEAD 追従 rev (`""` / `"HEAD"`) のときは active dir の `gitStatusChange` で再 fetch するが、`gitStatusChange` は `StatusFull` (mtime 込み Equatable) 由来で working-tree 編集ごとに飛ぶため、payload の `head` が前回 fetch 時と同一なら skip する (編集 churn を弾く)。ファイルの最新コミットが動くのは head 移動時 (commit / amend / reset / checkout / rebase) だけ。固定 hash rev は起点不変なので再 fetch しない
- 表示中ファイル / commit selection / mode 切替 / summary 切替で popover を閉じる経路は BlamePopover と同じ watcher / fsChange callback に併記 (`usePreviewRevs` の close watcher / `usePreviewContent` の `onBeforeRefetch`)

#### スコープ外

- rename を跨いだ履歴追跡 (`git log --follow`) は行 history (`logLine`) が追従していない先例に合わせて付けない
- ChangesSummaryView / ChangesSummaryItem (複数ファイル diff) へのコミット日表示は対象外。単一ファイル preview ヘッダのみ

### MarkdownPreview

- Markdown を HTML に変換して描画する。HTML はサニタイズして XSS を防ぐ
- YAML frontmatter はコードブロックとして描画する
- ` ```mermaid ` コードブロックは mermaid で SVG にレンダリングする（描画は共有層 `MarkdownBody.vue` が担うため preview / session-log など全 markdown 経路で効く）。parse error はブロック内にインライン表示する

> [!NOTE]
> mermaid は重量級ライブラリのため `MarkdownBody.vue` で dynamic import する。renderer は `codeSplitting: false`（単一バンドル）のため別 chunk には分かれないが、mermaid のトップレベル評価と `initialize()` は mermaid ブロックが現れるまで遅延される。
>
> 過去に一度 mermaid を依存ごと削除した経緯がある（`@mermaid-js/parser → langium → vscode-languageserver-*` の phantom dependency 問題）。現在の `@mermaid-js/parser` は langium を捨て chevrotain ベースに移行したため、この依存チェーンは解消済み。

#### リンクの遷移先ルール

Markdown 内のリンクは href の形式によって遷移先が決まる。リンク経路の役割分担は [architecture.md](architecture.md) の「外部リンクの navigation 防壁」と整合する。

| href の形式                                                         | 遷移先                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `http(s)://` / `mailto:`                                            | OS のデフォルトブラウザで開く（外部ナビゲーション）                                  |
| `#fragment` 単独                                                    | 同一文書内のアンカーへスクロール                                                     |
| `/` 始まり                                                          | worktree ルートからの相対パスとしてプレビュー対象を切り替える                        |
| `./` / `../` / 名前のみ                                             | 現在表示中の Markdown ファイルのディレクトリ基準で結合してプレビュー対象を切り替える |
| 行番号フラグメント (`./foo.ts#L42` 等)                              | path 部分でファイル切替、行番号は CodePreview の行ハイライト/スクロールに反映        |
| その他 scheme (`gozd-file:` / `file:` / `data:` / `javascript:` 等) | 無視（信頼境界外として遷移しない）                                                   |

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

### HtmlPreview

- ファイル内容を `srcdoc` で `<iframe>` に流し込みブラウザエンジンにネイティブ描画させる
- `sandbox=""`（全権限なし）を必須とする。`srcdoc` iframe は**デフォルトで親 origin を継承する**ため、sandbox を外すと iframe 内 JS が renderer と同 origin で動き、親 window の `__gozdElectronRpc`（contextBridge）に到達して任意 RPC（ファイル読み等）を叩けてしまう
  - `sandbox=""` で origin を opaque 化すると `<script>` は実行されず（静的 HTML + CSS のみ描画）、仮に scripts を許可しても opaque origin は親 window に触れず構造的に RPC を叩けない
- 相対パス参照（`<img src="logo.png">` 等）は file 取得経路を持たないため解決しない。自己完結した（CSS / asset を埋め込んだ）HTML のみ意図通り描画される
- background は web platform の default canvas（白）に固定する。iframe 内は gozd の themed UI ではなく白背景前提で書かれた外部 HTML 文書を描画するため、semantic token ではなくリテラル白が意味的に正しい

## Preview チェックボックス

SVG / Markdown / 画像 / HTML ファイルで、レンダリング結果とソースコードを切り替える。diff モードでは非表示。デフォルトは有効（プレビュー表示）だが、HTML のみデフォルト無効（ソース表示）。

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

## 編集機能

編集可能ファイルは **常時編集状態** で表示する（明示的な edit mode / Edit ボタンは存在しない。VS Code がファイルを開いたら即編集できるのと同じ）。編集面は Current タブ（CodePreview の `editable`）と Diff タブ（DiffPreview の Monaco diff editor。original readonly / modified 編集可）。対象は worktree 相対パスの実ファイル（`fsWriteFile`）と worktree 外の絶対パスの実ファイル（`fsWriteFileAbsolute`。設定 JSON / session log 等）。Original タブ・commit / PR diff モードは読み取り専用で、そこでは DiffPreview は自前 hunk 描画（blame / hunk 展開つき）の read-only 表示になる。commit / PR diff の読み取り専用 gate は worktreeRelative にのみ適用する: 絶対パスは git 文脈を持たず常に fs 実体の表示のため、git-graph の commit 選択が同居していても編集を塞がない。

編集セッション（target / draft / saved）は `usePreviewEditStore` が SSOT で、編集可能な content が表示されると `usePreviewEdit` の watch が自動でセッションを張る。Current タブと Diff タブは同じ draft を共有するため、片方での未保存編集はもう片方にも反映される（Diff タブの current 側には draft を渡す）。保存は明示的（Cmd+S / Save ボタン。keybinding の when は `previewEditable` context key）で自動保存はしない。Diff タブ編集の描画パスと props → model 同期の設計は DiffPreview の `<doc>`「編集パス」を参照。

保護境界は editMode フラグではなく **dirty（未保存変更の有無）**。外部変更（fsChange）や対象切替でない再取得は dirty の間だけ抑止し、クリーンなら追従してセッションを新しい内容で張り替える（VS Code のバッファと同じ意味論）。

### draft のライフサイクルと破棄境界

draft の生存は **preview が表示されている間だけ**。popover close は編集セッションごと畳む（`close()` の invariant。不可視の未保存 draft を残すと dirty 表示のないまま外部変更同期で無警告破棄される経路が生まれるため）。

破棄が起きる操作は dirty なら確認（Save / Don't Save / Cancel。`useUnsavedDraftConfirm` + `UnsavedDraftConfirmDialog`）を挟む。Save はクリーン化に失敗すると veto（操作を中止）する — VS Code の close confirmation と同じ意味論。

- ガードされる破棄境界: popover close の UI 経路（close ボタン / ESC / Cmd+W / toggle）、`requestSelect` / `forceSelect` の別ファイルへの切替、summary 進入、undocked window の close（close ボタン / Cmd+W / dock ボタン）
- ガードされない破棄境界（veto 不能）: worktree 切替（dir watch の sync close）、git-graph のコミット選択変化 / PR diff トグル（`targetChanged` → `endSession`）、アプリ終了
- undock は破棄ではなく **draft の移動**: snapshot に `initialDraft` として焼き込み、本体セッションは undock 時に畳む。未保存編集の所有者は常に 1 か所（本体 or ウィンドウ）に保たれ、確認なしで undock できる

編集中も blame が使える。Current タブは CodePreview と同じトリガー、Diff タブの Monaco diff editor は左右両側に `wireGutterBlame` を配線し、read-only の自前 hunk 描画と同じ side 契約（old → 比較元 rev / new → working tree）で BlamePopover を起動する。Unified（inline）表示の編集中は Monaco が original 側 pane を隠すため、old 側の blame は Split 表示でのみ使える。blame の対象は保存済みの working tree ファイルであり、未保存の draft で行がずれていると blame 行と表示行が一致しないことがある。draft の変更（タイピング）で popover は自動で閉じる。

UI は未保存の変更があるときだけ Discard / Save をコード領域右上にフローティング表示する。テキストラベル + 色（Save = primary、Discard = 地味）でフォームの cancel/submit パターンとして区別する。ESC は編集系の意味を持たず preview close に一本化（dirty なら close 前に上記の確認を挟む）。
