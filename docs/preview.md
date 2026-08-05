# Preview

ファイラーで選択したファイルの内容をプレビュー表示する。ファイル種別に応じたレンダリングと、git 変更ファイルの diff / original 表示を提供する。

## 責務の分離

markdown レンダリング・blame / file history popover・changes summary は preview から独立した子 feature として切り出す。preview 本体はファイルの選択・取得・表示モードの決定だけを持ち、レンダリング方式の変更が本体に漏れないようにする。

## ファイル種別

拡張子から判定する。マッチしないものは code として扱う。

| 種別     | 拡張子                                    | レンダリング                                          |
| -------- | ----------------------------------------- | ----------------------------------------------------- |
| image    | png, jpg, jpeg, gif, webp, avif, ico, bmp | 画像として描画                                        |
| svg      | svg                                       | 画像描画 / ソース切替                                 |
| markdown | md                                        | サニタイズした HTML として描画                        |
| html     | html, htm                                 | ネイティブ描画 / ソース切替                           |
| code     | その他すべて                              | エディタで表示（編集可否は[編集機能](#編集機能)参照） |

NUL バイトを含むファイルは拡張子ベースの種別判定に依らず、内容ベースの binary 判定で「Binary file」メッセージ表示に倒す。

HTML の Preview トグルは **デフォルト OFF（ソース表示）**。他のレンダリング種別（markdown / svg / image）はデフォルト ON だが、HTML は「ソースを読む」用途が主なため向きを反転させる。デフォルトの向きとトグル可否は独立した判定として扱う。

## モード切替

git 変更ファイルには Original / Diff / Current の 3 タブを表示する。タブ順序は時系列（過去 → 現在）。

### Uncommitted モード（デフォルト）

| 変更種別                 | 利用可能なモード        | デフォルト |
| ------------------------ | ----------------------- | ---------- |
| 変更なし                 | Current                 | Current    |
| modified, added, renamed | Original, Diff, Current | Current    |
| deleted                  | Original                | Original   |
| untracked                | Current                 | Current    |

### コミットモード（git-graph でコミット選択時）

変更種別は from / to の解決結果から導出する。

- 単一コミット選択: from = `<hash>^`, to = `<hash>`
- 範囲選択: from = `<older>^`, to = `<newer>`（older / newer はクリック順ではなく時系列順に整列）
- 端点に Working Tree を含む範囲選択: to は作業ツリーの実体、from は `<older>^`。Working Tree を表す sentinel は RPC 境界を越えず、ワイヤ上は常に実 git hash のみ流れる

Changes パネルのファイル一覧と同じ endpoint を使うため、両者の対象ファイル集合は常に一致する。

| 変更種別                                       | 利用可能なモード               | デフォルト |
| ---------------------------------------------- | ------------------------------ | ---------- |
| modified（from / to 両方あり + OID 差分あり）  | Original, Diff, Current        | Diff       |
| 変更なし（from / to 両方あり + blob OID 同一） | Current                        | Current    |
| added（from なし、to あり）                    | Current                        | Current    |
| deleted（from あり、to なし）                  | Original                       | Original   |
| 両方 not found                                 | Current（File not found 表示） | Current    |

「変更なし」判定は Filer 経由でコミット範囲外のファイルを選択したケースを救済する。Changes 経由では差分のあるファイルしかリストされないため発生しない。判定は blob OID の比較で行い、renderer 内のテキスト比較は行わない。Working Tree 端を含む範囲選択は OID が無いため「変更なし」ではないものとして扱う。

### Original タブの hash 表示

タブラベルは `Original (<hash>)` 形式で、実際に from として読んでいる ref を可視化する。

| 選択状態           | 表示        |
| ------------------ | ----------- |
| Uncommitted モード | `HEAD`      |
| 単一コミット       | `<hash7>^`  |
| 範囲選択           | `<older7>^` |

## 開閉機能

プレビューペインは右端に配置され、開閉可能。デフォルトは closed。

「ファイル選択 → preview を開く / 閉じる」の意思決定は 1 か所に集約する。各 entry point は intent に応じて呼び分け、watch chain で暗黙に発火させない。

### entry point × intent 決定表

intent は「同一 path を再選択したときに閉じるか」で分かれる。一覧や出力から行を選ぶ操作は同一 path でトグルし、特定のファイルを名指しで開く要求は表示を維持する。

| entry point                                  | 同一 path 再選択時の挙動  |
| -------------------------------------------- | ------------------------- |
| Filer ファイル行クリック                     | preview を close          |
| Changes ファイル行クリック                   | preview を close          |
| Terminal 出力中のファイルパス shift+click    | preview を close          |
| CLI `gozd <file>`                            | preview を維持（再 open） |
| File picker（Go to File / Cmd+P）で選択      | preview を維持（再 open） |
| MarkdownPreview 内部リンク click             | preview を維持（再 open） |
| MarkdownPreview back / forward               | preview を維持（再 open） |
| Session log dialog の生ログを開くボタン      | preview を維持（再 open） |
| Settings modal の設定ファイルを開くボタン    | preview を維持（再 open） |
| ChangesPane `View all` ボタン                | summary をトグル          |
| PreviewPane summary `Close` ボタン           | close                     |
| `preview.toggle`（Cmd+J / コマンドパレット） | 開閉反転                  |
| ESC キー                                     | close                     |
| Preview ヘッダの close ボタン                | close                     |
| worktree 切替（dir 変化）                    | close                     |
| 表示中ファイルが消える                       | close                     |

close は invariant として「popover 閉 ⇒ summary 解除」を担う。ESC / Preview ヘッダ close ボタン / dir 切替 / summary `Close` ボタンはすべてこの 1 つの経路に集約され、summary 有効 + popover 閉の整合性破綻状態は構造的に発生しない。

選択が成立しない入力は no-op に倒す（空 popover を作らない契約）。worktree 相対パスは dir 未確立時に弾かれるが、worktree 外の絶対パスは dir 文脈を必要としないため repo 未選択でも開ける（session log の生ログ preview が該当）。

例外として、同一 path 再選択時に Changes summary が表示中なら summary だけを解除し、popover は閉じず単一 file 表示に戻る。これは close の invariant とは別経路で、「summary を抜けて単一 file 表示にフォールバックする（popover は維持）」セマンティクスを持つ。

### その他の挙動

- worktree 切替（dir 変化）で自動クローズ。新 worktree でファイル選択を伴う dir 切替では、続けて再 open されるため最終状態は新ファイルで表示継続になる
- 外側クリックでは閉じない
- Cmd+W と ESC は同義で「フォーカスがあるサーフェスを閉じる」。フォーカスは前面に追従するため、結果として手前のものから順に閉じる（[keybinding.md](keybinding.md) の解決フロー、[workspace.md](workspace.md) のサーフェス節）。メニューやモーダルが開いているときはそちらに譲る
- undocked preview window の Cmd+S は**フォーカス**で宛先が決まる。in-app パネル内と、promote 後の OS ウィンドウ内で保存先が分かれる。close はネイティブ close も含め同じガード経路に合流する
- open / 前面化のたびにフォーカスが popover へ移る。terminal リンク経由の open でフォーカスが terminal に残ると入力先が見えない面のままになるため。close 時は開く前のフォーカス元へ戻す（terminal リンクから開いて閉じると terminal に入力が戻る）。popover 内部にフォーカスがあるとき（編集中等）は奪わない
- 開閉の SSOT は DOM を持たない状態に置き、popover DOM への反映は view 側が担う。既に開いている preview へ別の中身を出す経路は「開き直し」として view に届き、前面化に変換される
- IME 変換中の ESC（変換キャンセル）では閉じない
- 表示中ファイルが削除されると自動クローズ。作業ツリーで notFound になったとき HEAD の在否も確認し、**どちらにも無い**（= 未追跡ファイルの削除等で実体がどこにも残っていない）と確定した場合のみ選択解除 + close する
  - git 追跡下の削除ファイルは HEAD に内容が残り Original を閲覧できる（削除レビュー用途）ため閉じない。ファイル変更通知が git status の更新より先に届く race でも、HEAD 在否を直接読むことで誤クローズしない
  - HEAD 不在も git 実行失敗も同じ「不在」に畳んで扱う。RPC 自体が失敗したときだけ不在を確定できず、閉じずに notFound 表示に倒す
  - 単一ファイル削除も親ディレクトリごとの削除も同じ経路で拾う（ファイル監視が配下ファイル単位の削除イベントを出すため）
  - 閉じない条件は「summary 表示中 / 絶対パス / 作業ツリーに実体あり」のいずれか

### ファイル操作メニュー（⋮）

ヘッダの ⋮ ボタンで Open in default app / Copy file / Copy path のメニューを開く。項目とアクションは Filer / Changes の右クリックメニューと共通で、popover instance は共有しない（menu の種類ごとに独立の規律）。Copy file / Copy path の意味論は [filer.md](filer.md#ファイルコピーos-クリップボード) を参照。

Open in default app は表示中ファイルを OS のデフォルトアプリで開く。

- 対象は常に **working tree の実ファイル**。commit / PR diff モードで履歴版を表示中でも、開くのはディスク上の実体（git 履歴の内容ではない）。表示用のパスは RPC 入力に使わない契約のため流用しない
- ローカルファイルを開く intent は外部 URL を開く経路と別 RPC に分離する。後者は scheme allowlist（http / https / mailto）で `file://` を弾くため
- 実体が無いケース（選択無し / notFound / 履歴版の deleted を表示中）は ⋮ ボタン自体を描画しない（Copy file / Copy path を含むメニュー全体が出ない）。押せるが必ず失敗する silent dead button を作らない
- **相対 → 絶対の解決は基準ディレクトリ（worktree root）を持つ renderer の責務**。RPC には常に解決済みの絶対パスが渡る契約で、main 側は基準ディレクトリを持たず解決を**再実装しない**（再実装すると契約の SSOT が二重化する）
- ただし main は入口で**非絶対パス（空文字含む）を弾く**。これは解決ではなく、空文字や相対パスが CWD 基準で silent に絶対化される暗黙 fallback を塞ぐためのガード。特に空文字は CWD として存在チェックも通り、Finder で CWD を黙って開く誤動作になる
- main 側の存在チェックは契約検証ではなく、描画 gate を抜けた race（表示直後に実体が消えた等）向けの safety net。不在ならエラーで弾き（無言 no-op を避ける）、renderer はトーストで通知する。アクセス制御の関所ではない

## データ取得

表示に必要な内容は用途ごとに取得元が分かれる。

| 取得元       | 用途                                     |
| ------------ | ---------------------------------------- |
| 作業ツリー   | 現在のファイル内容（バイナリ判定を含む） |
| HEAD         | Uncommitted モードの Original / Diff     |
| コミット間   | コミットモードの from / to（一括取得）   |
| ファイル履歴 | ヘッダのコミット日と file history        |

- 画像 / SVG: 専用経路を持たず、テキストと同じ read 経路で取得した content から表示する。content はテキスト / バイナリを型で区別して運び、表示はデータ取得層の意味論（live の再取得 / undocked snapshot の固定）をそのまま反映する。Original タブも各取得経路が実際に参照した rev の内容が映る
- worktree 外の絶対パスは git 操作を呼ばず、fs 読み単独で読み切る（画像 / SVG も同じ）
- rename（move）されたファイルの Original / Diff: git status のキーは新パスのみ持つため、status と同一 snapshot で届く「新パス → 旧パス」の対応で HEAD 側のパスを解決してから読む。旧パス解決を欠くと HEAD 側が notFound になり「全行追加」の diff に倒れる。Uncommitted モードの HEAD 側 blame も同じ対応で旧パスに揃える
- バイナリ判定は main 側が行い、content の型で表現する（フラグは持たない）

## リアクティブ更新

### git status 変化時（Uncommitted モードのみ）

git status が更新されると再取得する。**タブはリセットしない**。対象切替でない再発火（自分の save で unmodified → modified になった等）でデフォルトモードへ倒すと、Current で編集保存した瞬間に diff タブへ勝手に切り替わってしまう。ユーザーの選んだタブを維持し、変化で現在タブが成立しなくなったとき（外部 checkout で diff が消える等）だけデフォルトへ倒す。タブのリセットはファイル選択・コミット選択・PR diff トグルの切替時のみ。

### コミット選択変化時

コミット選択が変わると再取得する。

### ファイル内容変更時（Uncommitted モードのみ）

選択中ファイルの親ディレクトリが変更対象なら再取得する。モードや Preview チェックボックスの状態は維持する。コミットモードでは git オブジェクトからの取得済み内容を表示するため、ファイル変更通知は無視する。

worktree 外の絶対パス選択はディレクトリ監視の対象外で通知が届かないため、表示している間だけ単一ファイル監視を張る（設定 JSON / session log 等）。モード維持の規律は同じ。dirty 中の変更イベントは捨てずに保留し、編集終了（Discard / Save / セッション終了）で dirty が落ちた時点で再取得する — 捨てると Discard 後に外部変更前の stale な内容へ巻き戻り、そのまま保存で外部変更を上書きしてしまうため。選択が外れたら監視を解除する（main 側は path ごとの refcount で undocked window と共有）。

ファイル監視は全 worktree を対象とするため、通知元 dir が active dir と一致するものだけに反応する（[architecture.md の SSOT push の dir filter 規律](architecture.md#ssot-push-の-dir-filter-規律)）。worktree 直下ファイルの親ディレクトリ表現を揃え、root 直下ファイルの通知を取りこぼさないようにしている。

### 非同期レース防止

取得ごとに世代を進め、レスポンス到着時に世代が一致しなければ結果を破棄する。

## 各サブコンポーネント

### CodePreview

- エディタで表示・編集する。検索と仮想スクロールはエディタ標準の機能をそのまま使う。編集可否の切替でタブ切替時に remount されない
- シンタックスハイライトの言語検出は拡張子 / ファイル名から行い、gozd 固有の policy（例: `.m` を Objective-C とみなす）を上書きとして持つ。ハイライタが対応しない言語はエディタ組み込みの言語メタデータへ fallback する
- word-wrap をトグルできる
- 行番号指定のリンク（`:行番号` サフィックス）から開いたときは該当行にスクロールし、行全体をハイライトする
- blame 有効時は行番号クリック、または context menu / コマンドパレットの "Show Blame for Line" から blame を起動する。popover の anchor は起動時の位置に固定するため、スクロールしたら閉じる
- 末尾改行の直後に描画される空の最終行（git の行数に存在しない）は blame 対象外

### DiffPreview

- 表示モードは `split`（default）/ `unified` の 2 つ。preview セッション内でだけ保持し永続化しない
- **diff 計算の SSOT は git**。renderer 側で全文 LCS を回すとロックファイル級の数万行ファイルでメインスレッドが固まるため、行単位の差分算出は git に委ねる
  - diff algorithm と改行の扱いはユーザーの global config に依存させず固定する
  - 総行数も算出結果に含めて受け取る。renderer が独自に行を数えると git の line counting 規約と分かれ、表示行数がずれる
  - hunk 間 / ファイル先頭・末尾の連続 unchanged 行は「N unchanged lines」バーで省略表示し、クリックで展開する。展開時の行の切り出しも git と同じ line counting 規約で行う
  - 失敗時は pane 内に表示する（トーストだけだと閉じた後に状態を追えない）
- 入力契約: original / current は UTF-8 として解釈可能なテキスト。バイナリは上位の判定で弾く前提。すり抜けた場合は「正常終了したが出力フォーマットが想定外」として観察可能化する
- シンタックスハイライトは original / current それぞれのトークンを diff の各行に対応付ける
  - unified: removed 行 → original、added / unchanged 行 → current
  - split: 左側 → original、右側 → current
  - diff の色分けは背景色のみ。テキスト色はトークンに委ねる
  - 言語未対応時はフォールバック表示（追加 = 緑、削除 = 赤）
- 行内（文字単位）ハイライト: 変更ブロック（removed run × added run）の内側を文字単位で再計算する
  - 行単位 diff の SSOT は git のまま。行内は表示専用の追加レイヤーで、hunk 構造と矛盾しない
  - 行背景と行内変更範囲は明度で二層に分ける。沈む側での差別化は dark パレットの低ステップ圧縮で知覚できないため採らない。純粋な追加 / 削除行と、予算切れで degrade した範囲は行全体を一様に塗る
  - メインスレッド同期実行のため 1 ファイル合算の時間予算で打ち切り、超過分は行単位表示に degrade する（エラーにしない）
- unified と split の両方を取得時に事前展開して保持する。view mode 切替で再 fetch は走らない
- split view では modified hunk 内で連続する removed run と added run を貪欲ペアリングし、余った片側は反対側の行を空にして残す
- Cmd+A の scope は hunk-bar を含まない。省略行のラベルは clipboard に乗らない。split では focus が居る半身 1 つだけに閉じる
- Cmd+A の scope 制御は **focus が leaf 内に居るときの挙動**に限定される。focus がトグル / タブ / ヘッダボタン等の leaf 外要素に乗っているときの Cmd+A はブラウザが document scope に倒し、preview popover 外を含む document 全体が選択される。これは「Cmd+A を JS で intercept しない」「選択禁止の指定を scope 制御に使わない」（全選択はその指定を honor しないため）方針から構造的に残る帰結。leaf 外 focus 時に preview 内へ閉じたい場合はユーザーが leaf を 1 回クリックして focus を移す前提
- clipboard は「1 行 = 1 改行」になる。行番号はテキストとして DOM に存在せず clipboard 対象外（CodePreview と同じ規約）。word-wrap 時は折返し行が行番号の幅で indent 揃えされる
- split の左右は常に 50/50 に固定し、コンテンツ量比で割れないようにする。半身単位の overflow box は持たず、50% を越える長い行は枠を越えて描画され、diff 全体の横スクロールで参照する。word-wrap で左右の折返し行数が違っても、行ごとに高い方に合わせて左右の同じ行が揃う
- 行番号は blame 有効時だけ操作可能な要素として描画し、クリックで blame を起動する。old 側は Original 側 rev、new 側は Current 側 rev を指す。blame 無効時は focusable にも hover 対象にもしない（silent dead button を作らない契約）

### BlamePopover

行番号クリックで開く blame / line history popover。Esc / 外クリックでの dismiss と viewport flip はブラウザに委譲する。popover 機構は共通抽象に委譲し、この層は blame / line history の RPC race だけを所有する。

#### 起動経路

open / close / state は単一の状態に集約し、view は購読して描画するだけで操作を持たない（親から子の内部メソッドを呼ぶ設計は禁止）。popover 自体はレイアウト最上位に 1 度だけ mount する。

#### rev の決定ルール

| 経路                                            | rev                           |
| ----------------------------------------------- | ----------------------------- |
| Uncommitted モードの Current                    | `""`（空文字 = working tree） |
| Uncommitted モードの Original                   | `HEAD`                        |
| コミットモードの Current（newer = 実 hash）     | `<newer hash>`                |
| コミットモードの Current（newer = WorkingTree） | `""`                          |
| コミットモードの Original（単一 commit 選択）   | `<newer>^`                    |
| コミットモードの Original（範囲選択）           | `<older>^`                    |
| Diff モード（clicked side = old）               | Original 側の rev             |
| Diff モード（clicked side = new）               | Current 側の rev              |

Diff モードでは行が属する側で判定する。片側だけの add / remove 行は反対側に行番号がなく操作要素も描画されないので、clicked side は常に存在する側だけになる。

#### 2 ステート

- **Blame**: 1 行に絞って commit hash / author / 相対日付 / summary を表示。working tree の未コミット行は "Not committed yet" 表記に倒す
- **History**: その行を変更してきた commit 一覧を新しい順で表示。click で git-graph 側の選択に反映しつつ popover を閉じる

History は blame 完了を必ず待ってから走る。起点 commit と起点行番号は blame が返した値に固定する。呼び出し元の rev を起点に渡すと、Original（`<older>^`）などで「blame した commit を含まない history」が返って意味契約が壊れるため。blame の失敗 / cancel 時は history も失敗に倒す。未コミット行は history が空になるため History タブを disable し説明文を出す。

#### 状態同期と race

- 表示中ファイル / commit 選択 / 表示モードのいずれかが変わると閉じる（文脈が乖離した popover を残さない）
- **anchor が DOM から外れる経路ではすべて閉じる**。内容の再取得は取得の**前**に閉じ（行番号の要素が置換されるため、再描画と同フレーム）、summary の出入りや一覧更新で項目そのものが消える場合はその時点で閉じる
- エディタのスクロールでも閉じる。anchor はクリック時の位置に固定した要素のため、スクロールすると行とずれた位置を指し続ける（全行が実 DOM の read-only 表示では anchor がスクロールに追従するのでこの経路は不要）
- draft 変更（タイピング）でも閉じる。blame は保存済み working tree に対して走るため、行の増減で blame 行と表示行が乖離した popover を残さない
- 閉じる要求は「文脈が完全一致する場合のみ閉じる」形にする。他 owner の文脈にぶつけても no-op で安全
- Esc / 外クリックを含む close はすべて 1 つの経路に集約され、進行中の RPC を破棄して state を初期化する
- open / close で世代を進め、進行中の blame / history は復帰時に世代が違えば結果を破棄する
- 進行中の blame は世代と対にして保持する。history は待つ前に自分の世代を capture し、同じ世代の blame だけを待つ。素の参照で待つと、別の行を開いた後も古い blame を待ち続ける

#### main 側の防御

- rev は「空文字 / `HEAD` / hex hash + 末尾 `^` `~`」のみ許可する。`-` 始まりや空白文字は option 注入として reject
- blame は空文字 rev（working tree）を許容するが、history は空文字を reject する。history の rev は blame した commit hash を起点として流す契約のため、空文字で HEAD 起点 walk に倒れると意味契約が壊れる
- blame 対象ファイルはサイズを先に測り、上限を超えるなら reject する。巨大ファイル全体の walk による UI ブロックを防ぐ
- サイズ取得失敗の silent 通過は「予期された不在」経路のみ許す（working tree はファイル不在、git 側は path 未解決）。それ以外は throw で観察可能化する
- path に `:` を含むと行指定の履歴取得は syntax が壊れるため reject する
- blame 出力の parse は各行を trim してから処理し、trailing whitespace で数値 parse が silent に 0 へ倒れるのを防ぐ

#### スコープ外

- 非 git project、および絶対パスで開いたファイルは git 管理外として、行番号の操作要素自体を描画しない（popover は起動しない）
- 単一行のみ。範囲選択（multi-line）はスコープ外

### FileCommitDate / FileHistoryPopover

BlamePopover が **行単位**なのに対し、こちらは **ファイル単位**。preview ヘッダにファイルの最終コミット日を常時表示し、クリックでファイル全体の commit 履歴 popover を開く。一覧 commit のクリックで git-graph の選択に反映する挙動は行 history と同じ。

行単位とは別経路で、blame ステップを持たず history 一本の state だけを管理する。popover 機構と commit 行のマークアップは行 history と共有する。

#### rev の決定ルール

ヘッダのコミット日 / file history の起点 rev は **表示中タブに追従**する。

| 表示タブ       | rev                                |
| -------------- | ---------------------------------- |
| Original       | Original 側（`HEAD` / `<older>^`） |
| Current / Diff | Current 側（`""` / `<newer>`）     |

ファイル history は行 history と違い **空文字 rev を許容**する（空文字 = HEAD walk = ファイルの最新コミット起点）。blame 起点の契約がファイル history には無いため。Diff タブは単一 rev を持たないため Current 側 rev を代表に使う。

#### 表示 gate とリアクティブ更新

- git repo かつ selection が worktree 相対かつ rev 解決済み、かつディレクトリでないときだけ日付を表示する（非 git project / 絶対パス / 不整合 / ディレクトリを除外し、silent dead button を作らない）
- ファイル切替 / タブ・commit 選択切替で再 fetch する。race は世代で破棄する
- HEAD 追従 rev のときは HEAD が動いたときだけ再 fetch する。git status の通知は working-tree 編集ごとに飛ぶため、HEAD が同一なら skip して編集 churn を弾く。ファイルの最新コミットが動くのは HEAD 移動時（commit / amend / reset / checkout / rebase）だけ。固定 hash rev は起点不変なので再 fetch しない
- 表示中ファイル / commit 選択 / モード切替 / summary 切替で popover を閉じる経路は BlamePopover と同じ

#### スコープ外

- rename を跨いだ履歴追跡は、行 history が追従していない先例に合わせて付けない
- 複数ファイル diff（Changes summary）へのコミット日表示は対象外。単一ファイル preview ヘッダのみ

### MarkdownPreview

- Markdown を HTML に変換して描画する。HTML はサニタイズして XSS を防ぐ
- YAML frontmatter はコードブロックとして描画する
- mermaid コードブロックは SVG にレンダリングする（描画は共有層が担うため preview / session-log など全 markdown 経路で効く）。parse error はブロック内にインライン表示する

> [!NOTE]
> mermaid は重量級のため、mermaid ブロックが現れるまで読み込みと初期化を遅延する。

#### リンクの遷移先ルール

Markdown 内のリンクは href の形式によって遷移先が決まる。リンク経路の役割分担は [architecture.md](architecture.md) の「外部リンクの navigation 防壁」と整合する。

| href の形式                                           | 遷移先                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `http(s)://` / `mailto:`                              | OS のデフォルトブラウザで開く（外部ナビゲーション）                                  |
| `#fragment` 単独                                      | 同一文書内のアンカーへスクロール                                                     |
| `/` 始まり                                            | worktree ルートからの相対パスとしてプレビュー対象を切り替える                        |
| `./` / `../` / 名前のみ                               | 現在表示中の Markdown ファイルのディレクトリ基準で結合してプレビュー対象を切り替える |
| 行番号フラグメント（`./foo#L42` 等）                  | path 部分でファイル切替、行番号は行ハイライト / スクロールに反映                     |
| その他 scheme（`file:` / `data:` / `javascript:` 等） | 無視（信頼境界外として遷移しない）                                                   |

#### 例外条件と通知

- worktree ルートの外を指すリンク（`../` で抜ける等）と不正な URL エンコードは通知のみでファイル切替を行わない
- 行番号でない anchor（見出しアンカー等）はファイル切替は行うが、見出しスクロールは行わず通知で挙動を明示する（自動スクロールは未対応）
- 中ボタンクリックも左クリックと同じ経路に通す。片方だけ bind すると中クリックが既定の new-window 要求に落ち、外部送りの allowlist を迂回して OS に URL が渡る
- control+click はリンク起動として扱わず既定挙動（コンテキストメニュー）に渡す。macOS では control+click が左クリックとして dispatch されるため、除外しないと右クリックの意図で外部送りが走る。それ以外の修飾子付きクリックは通常クリックと同じ経路（preview にタブ / window のモデルが無く、別挙動を与える意味がない）
- 通知は href ごとに別メッセージを出さず、固定 message と詳細 cause に分けて重複抑制を効かせる

#### 内部リンク遷移の履歴（back / forward）

Markdown preview 内の内部リンククリックは back / forward 履歴に積まれる。ブラウザの「戻る / 進む」と同じモデルで、双方向スタックを保持する。

仕様契約:

- リンククリック時: 現在の selection を back スタックに積み、forward スタックを破棄する
- back / forward の操作はスタックの pop と「現在の selection を反対側に push」を 1 つの不変条件として実行する
- 同じパスかつ同じ行番号への再遷移は履歴に積まない（自己リンクや同一ファイル間の往復で重複が混入しないため）
- PreviewPane ヘッダに back / forward ボタンを常時描画する。履歴の有無で header の幅が揺れないよう、操作不能側は disabled で表現する
- キーバインドは preview popover が開いていてかつ入力欄にフォーカスが無い時だけ発火する。コマンドパレットからもラベル付きで実行できる

履歴のスコープ:

- 履歴に積まれるのは **MarkdownPreview のリンククリック由来の遷移のみ**
- filer クリック / terminal リンク / プログラム的な selection 更新 / worktree 切替など、それ以外の経路で selection が変化した瞬間に両スタックを破棄する

履歴スタックの上限: **設けない**。md preview の navigate は人間がリンクをクリックする経路でのみ発生するため、現実的な操作頻度で memory pressure になる事象は観測されていない。本契約を変更する場合は本ファイルを SSOT として書き換え、実装側に隠れた cap を入れない。

### ImagePreview

- 画像として描画し、縦横比を維持する

### HtmlPreview

previewed HTML を **実 URL の load** としてネイティブ描画する。

- **なぜ文字列の埋め込みではないか**: 文字列を流し込むと document の base URL が親（renderer）のものになるため、previewed HTML の相対リンク・画像・CSS が原理的に解決しない。origin も opaque になり、リンククリックを傍受する経路も無くなる。実 URL なら普通の HTTP と同じ理屈で全部成立する
- **信頼境界**: previewed HTML はリポジトリ内の任意ファイルで untrusted。実 origin を与える代わりに、能力は配信時に落とす。script は動かず、外部への参照もできず、origin が renderer と異なるため親の RPC bridge には到達しない
- **preview ごとの隔離**: origin は preview instance ごとに分かれ、配信範囲もその preview に紐づく。origin を共有すると同一 origin 扱いになって隔離が壁にならず、ある preview の HTML から別 preview の配信範囲を参照できてしまう（複数 repo の同居は gozd の機能要件なので、信頼境界の違うコンテンツが同時に開かれるのが常態）
- **配信範囲**: preview が要求した root 配下だけ。範囲外は配信しない。root は worktree 内のファイルなら worktree root、worktree 外の絶対パスならそのファイルが居る dir に絞る
- **配信許可の寿命**: 許可は preview に紐づき、preview が消えるときに手放す。同じ preview が別 root を要求したら前の root は置き換わる。許可の取得と解放は直列化し、in-flight の要求が解放の後に完了して許可を復活させないようにする
- **表示できる rev**: 配信は working tree の実ファイルを読むため、**表示中の rev がディスクの実体と一致するときだけ**ネイティブ描画する。Original / commit 選択 / PR diff / 実体なし（deleted 等）では source 表示に倒す。markdown は内容を渡して描画するのでこの制限を受けず、同じ commit を選んでも preview が効く点が観測可能な差になる
- **更新の反映**: 内容が変わったら表示に反映する。反映は参照している CSS / 画像にも及ぶ（参照先の URL が変わらなくても古い内容は残らない）。契機は表示中の内容の変化だけで、選択や git status の更新では再描画しない。並列エージェントが常時ファイルを書き換える前提のため、無関係な変更で preview 内の遷移先やスクロール位置が入口に戻らないようにする
- **popup を封じる**: 中クリック / 別ウィンドウ要求はブラウザにブロックさせ、何も起こさない。この frame はクリックを傍受できる層が無いため、popup 経路が生えると外部送りの allowlist を迂回する
- **リンク遷移**: 左クリックのうち配信範囲内への遷移は preview 内のページ移動として成立し、外部 URL（http / https / mailto）は OS のブラウザで開く（この frame のクリックを受け取れる層が navigation 防壁しか無いため。[architecture.md](architecture.md) 参照）
- background は白に固定する。ここで描画するのは gozd の themed UI ではなく白背景前提で書かれた外部 HTML 文書のため、テーマ由来の色ではなくリテラル白が意味的に正しい

## Preview チェックボックス

SVG / Markdown / 画像 / HTML ファイルで、レンダリング結果とソースコードを切り替える。diff モードでは非表示。デフォルトは有効（プレビュー表示）だが、HTML のみデフォルト無効（ソース表示）。

## Changes summary view

ChangesPane の `View all` ボタンで preview ペインを「全変更ファイルの diff を縦並びで表示するモード」に切り替える。GitHub PR の Files changed タブ相当。

### スコープと追従

- 表示する変更ファイル一覧は Changes パネル（ファイルツリー）と同じ SSOT を共有する。uncommitted / 単一コミット / 範囲選択 / PR diff のいずれの選択状態にも追従し、ChangesPane と summary は常に同じファイル集合を見る
- worktree を切り替えると summary は自動で解除される（Filer 選択が clear されるのと対称）

### PR diff モード

ChangesPane ヘッダの `PR #<n>` toggle が ON のとき、summary を含む各 view は「**`merge-base(HEAD, PR の base)` から working tree まで**」（GitHub Files changed と同じ 3-dot semantics）の diff に切り替わる。base を直接起点にすると、PR 分岐後に base ブランチが前進した分が逆向きに差分として混入するため、必ず merge-base を取り直してから使う。

- 一覧は merge-base 起点の差分に untracked を merge した形になる
- per-file diff は merge-base 側の内容と working tree の内容を並列取得して描画する
- Filer 経由で PR diff に含まれない（merge-base 起点で無変更の）ファイルを選択したケースは、working tree の中身を Current に出して救済する。「変更種別 → 利用可能モード」対応表の「変更なし」行と対称。空表示に倒すと Filer で見えているファイルが PR モード中だけ読めなくなる非対称が生じるため。base 側を読まないので存在しないパスに対する bogus な stderr も出ない
- ただし「変更なし」には PR diff 一覧の取得が未確定な race も混ざる（トグル直後は一覧が空で、diff 内の tracked ファイルも一時的に消える）。これを Current 救済に倒すと、変更済みファイルを開いたまま PR モードをトグルした際にデフォルトタブが Diff から Current に落ちる。取得中は救済せず、一覧確定による再発火に委ねる
- 有効化は「PR に到達可能か判定 → 必要なら fetch → merge-base を解決」の順で行い、解決した merge-base を snapshot して以降の基準に使う
- git-graph の selection は触らない。ユーザーが graph で commit を選んだら自動 OFF になる
- PR が見つからない / base が未解決のときは toggle 自体を gate する
- base が local に reachable でないとき（未 fetch）は 1 回だけ自動 fetch する。merge-base の解決失敗（unrelated histories 等）は通知を出して有効化をキャンセルする

### UI 構成

- 1 ファイル = 1 ブロック。ヘッダー（アイコン / パス / 変更種別バッジ / 折りたたみトグル）と diff 本体の組み合わせ
- 表示モード（split / unified）と word wrap はビュー全体で 1 つのツールバーに統合され、各 diff に共通で適用される。ファイル個別のトグルは出さない

### モード遷移

- Filer や ChangesPane でファイル行をクリックすると summary は解除され、単一ファイル表示に戻る
- git-graph 上で commit / range を切り替えても summary は維持される（上のスコープに従ってファイル集合が入れ替わる）
- summary 解除は preview の close に集約される（上述の invariant）。ChangesPane の `View all` 再押下、summary 内 `Close` ボタン、ESC、Preview ヘッダ close ボタンはすべて同じ経路
- summary を有効化すると preview popover が自動で開く（summary 有効化と popover open をペアで遷移する）

### データ取得とリアクティブ更新

- 各ファイルの diff は単一ファイル view と同じ取得経路に従う（uncommitted は HEAD vs 作業ツリー、コミット / 範囲は git オブジェクトから）。差分は per-item に個別フェッチされる
- 大量変更でも初期描画を固めないため、各 item はビューポートに入って初めて diff をフェッチする（lazy 取得）
- uncommitted モードでは[単一ファイル view と同じ「リアクティブ更新」規律](#リアクティブ更新)に従い、ファイル中身が変われば diff が自動で hot-reload される。コミットモードでは fs 変更は無視する

### 失敗時の通知

- 個別ファイルの取得失敗は item ブロック内に赤テキストで表示される
- 複数ファイルの並列フェッチが同時に失敗するケースに備え、summary は失敗を debounce で集約し、固定メッセージのトースト 1 件にまとめる（debounce 窓ごとに 1 件。窓を跨いだ失敗は独立した通知項目になる）。詳細件数と直近の原因は notification center の cause 詳細に展開される

## 編集機能

編集可能ファイルは **常時編集状態**で表示する（明示的な edit mode / Edit ボタンは存在しない。VS Code がファイルを開いたら即編集できるのと同じ）。編集面は Current タブと Diff タブ（original は readonly、current 側が編集可）。対象は worktree 相対パスの実ファイルと worktree 外の絶対パスの実ファイル（設定 JSON / session log 等）。Original タブ・commit / PR diff モードは読み取り専用で、そこでの diff 表示は blame / hunk 展開つきの read-only になる。読み取り専用の gate は worktree 相対パスにのみ適用する: 絶対パスは git 文脈を持たず常に fs 実体の表示のため、git-graph の commit 選択が同居していても編集を塞がない。

編集セッション（target / draft / saved）は単一の状態に集約し、編集可能な content が表示されると自動でセッションを張る。Current タブと Diff タブは同じ draft を共有するため、片方での未保存編集はもう片方にも反映される。保存は明示的（Cmd+S / Save ボタン）で自動保存はしない。編集セッションがあるときだけ成立する。

保護境界は編集モードのフラグではなく **dirty（未保存変更の有無）**。外部変更や対象切替でない再取得は dirty の間だけ抑止し、クリーンなら追従してセッションを新しい内容で張り替える（VS Code のバッファと同じ意味論）。

### draft のライフサイクルと破棄境界

draft の生存は **preview が表示されている間だけ**。不変条件は「セッションが存在 ⇔ popover 表示中 && summary 外 && 編集可能 content 表示」で、両方向を別の場所が担う。畳む側は close（popover 閉 ⇒ セッション破棄。不可視の未保存 draft を残すと、dirty 表示のないまま外部変更同期で無警告破棄される経路が生まれるため）と summary 進入。張る側は可視状態を含めた同期観測（再 open / summary 退出は content が変化しないため、可視状態自体を発火源にしないと張り直せない）。

破棄が起きる操作は dirty なら確認（Save / Don't Save / Cancel）を挟む。Save はクリーン化に失敗すると veto（操作を中止）する — VS Code の close confirmation と同じ意味論。

- ガードされる破棄境界: popover close の UI 経路（close ボタン / ESC / Cmd+W / toggle）、別ファイルへの切替、summary 進入、undocked window の close（in-app パネルの close ボタン / Cmd+W、昇格後はネイティブ close を確認に変換 / dock ボタン）
- ガードされない破棄境界（veto 不能）: worktree 切替、git-graph のコミット選択変化 / PR diff トグル、アプリ終了
- undock は破棄ではなく **draft の移動**。snapshot に焼き込み、本体セッションは undock 時に畳む。未保存編集の所有者は常に 1 か所（本体 or ウィンドウ）に保たれ、確認なしで undock できる

編集中も blame が使える。Diff タブでは左右両側から起動でき、read-only 表示と同じ side 契約（old → 比較元 rev / new → working tree）に従う。Unified 表示の編集中は original 側の面が隠れるため、old 側の blame は Split 表示でのみ使える。blame の対象は保存済みの working tree ファイルであり、未保存の draft で行がずれていると blame 行と表示行が一致しないことがある。draft の変更（タイピング）で popover は自動で閉じる。

UI は未保存の変更があるときだけ Discard / Save をコード領域右上にフローティング表示する。テキストラベル + 色（Save = primary、Discard = 地味）でフォームの cancel / submit パターンとして区別する。ESC は編集系の意味を持たず preview close に一本化する（dirty なら close 前に上記の確認を挟む）。
