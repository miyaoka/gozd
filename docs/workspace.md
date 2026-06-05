# ワークスペース設計

並列プロジェクト・並列 worktree による開発環境の管理。

## コンセプト

- gozd はオーケストレーターであり、複数の Claude エージェントが並列に作業することを前提とする
- git worktree を活用し、ブランチごとに独立した作業環境を提供する
- 人間は main で確認作業を行い、各 worktree では Claude が独立して開発する

## 階層構造

```text
ウィンドウ
├── repo A（git リポジトリ）
│   ├── main（メインディレクトリ = 参照・確認用）
│   ├── YYYYMMDD_HHMMSS (feature-a)
│   └── YYYYMMDD_HHMMSS (fix-bug)
├── repo B（git リポジトリ）
│   ├── main
│   └── YYYYMMDD_HHMMSS (...)
└── plain dir C（git 管理外）
```

1 ウィンドウに複数の repo / 非 git dir を同居させて、サイドバー上部の repo 切替リストで切り替える。VS Code 系（per-workspace window）から **Tower / GitHub Desktop 系（管制塔型）** への転換。

`gozd <path>` を実行すると、対象 path が既存 repo の worktree に含まれていればその repo にフォーカス + worktree 切替、含まれていなければ新規 repo として既存ウィンドウに追加される。新ウィンドウは作らない。

非 git ディレクトリも同じ仕組みで「project」として登録される。worktree 概念がないため、`RepoSection` 内に WtCard 列は描かれず、ヘッダとターミナルのみが利用可能。

## アプリ状態の復元

`~/.config/gozd/app-state.json` に最後のウィンドウ状態を保存し、次回起動時に sidebar として hydrate する。dev / stable で同じファイルを共有する。

save の発火条件は `buildAppStateSnapshot()` のシリアライズ結果が前回と変化した時のみ。`worktrees` / `gitStatuses` / `task` などサイドバー描画用のデータは snapshot に含まれないため、git status push / `fetchRepo` / Task title 同期では save が走らない。発火するのは `dirOrder` / `collapsedRoots` / `selectedDir` / 各 repo の `repoName` / `isGitRepo` が実際に変化した時のみ。

> [!WARNING]
> dev / stable を同時起動して両方の sidebar を編集した場合、最後に save したプロセスが他方の sidebar 状態を上書きする。プロセス間ロックは未実装。詳細は [architecture.md](./architecture.md#データ永続化) を参照。

保存する情報:

- sidebar に表示中の repo 一覧（`sidebarRepos`: rootDir / repoName / collapsed）
- 最後にアクティブだった worktree ディレクトリ（`lastOpenedDir`）
- ウィンドウフレーム（位置・サイズ）

起動時の挙動:

- CLI の launch request ファイル（`gozd <dir>` 時）があればその dir を開く
- それ以外（Dock/Finder / `pnpm dev` 起動時）は launch request なし → renderer が `app-state.json` を hydrate して sidebar を復元する。active dir の自動選択は未実装で、ユーザーが sidebar から手動選択する
- 初回起動時（state なし）は空の sidebar で待機する

## プロジェクト管理

### 解決フロー

1. CLI / Add directory ボタンが絶対パス（`targetPath`）を native に送信
2. native の `buildGozdOpenPayload` が:
   - `git rev-parse --show-toplevel` で git toplevel を解決（成功時 `isGitRepo=true`）
   - `git rev-parse --git-common-dir` の親から **main repo の basename** を取得して `repoName` にする（worktree から開いても timestamp 名にならない）
   - 非 git の場合は `targetPath` をそのまま `dir` として扱う
3. payload を `gozdOpen` イベントとして renderer に push
4. renderer の `useRepoStore.findRepoOwning(targetDir)` で既存 repo の worktrees に target が含まれるかチェック
   - 含まれる: `selectDir(targetDir)` のみ（既存 repo にフォーカス + 該当 worktree 切替）
   - 含まれない: 新規 repo として `addRepo` + worktrees / branches を fetch

### 永続化

`app-state.json` の `sidebarRepos` で同居中の repo 一覧（rootDir / repoName / collapsed 状態）を永続化済み。

未実装:

- 起動時の active worktree 自動復元（`lastOpenedDir` は保存されているが hydrate 時に `selectedDir` へ反映していない）
- worktree ごとの setup / teardown スクリプト（`pnpm install` 等の初期化自動化）

将来的に永続化対象が大きく増えた場合は SQLite への移行を検討する。

## Worktree 運用ルール

### main ブランチ

- メインディレクトリ（clone 元）が main の worktree として機能する
- main は参照・確認専用。dev サーバーの起動や build は自由に行える
- main で直接コミットしない。Claude も main では作業しない
- 「参照用」は規範ではなく、新規 worktree がリモートのデフォルトブランチ（`origin/HEAD`）を起点に作られる仕様の帰結。main はその起点を最新に保つために pull する場、という位置づけになる
  - サイドバーの新規 worktree ボタン / Issue picker 経由はリモートのデフォルトブランチ起点
  - PR picker 経由はその PR の head ブランチを `origin` 上で解決した ref 起点。fork PR は head が `origin` 上に無いため picker のリスト時点で除外する

### 作業用 worktree

- 新しい作業を始めるときは必ず worktree を作成する
- worktree 作成時にタイムスタンプ形式のブランチ名（`YYYYMMDD_HHMMSS`）を自動生成する
- ブランチ名は `git branch -m <名前>` でいつでもリネームできる（worktree の紐づけは追従する）
- PR 作成時にリネームを促す導線を用意する。検証だけで終わる worktree は名前を付けずに削除してもよい
- 各 worktree は独立したファイルシステムを持ち、`pnpm install` / `pnpm dev` / `pnpm build` を独立して実行できる

### シンボリックリンク共有

worktree 作成時に、メインリポジトリの指定ファイル/ディレクトリを新 worktree にシンボリックリンクできる。`.claude/`（Claude Code のローカル設定・許可済みコマンド）や `.env.local`（環境変数）など、git 管理外のローカル設定を全 worktree で共有するための仕組み。

- 対象パスはプロジェクト設定（`~/.config/gozd/projects/<projectKey>/config.json` の `worktreeSymlinks`）で管理する
- サイドバー下部の「Worktree symlinks」パネルで編集できる
- メインリポジトリに存在しないパス、または worktree 側に既に存在するパスはスキップされる

### git worktree の制約

- ブランチと worktree は 1:1。同じブランチを複数の worktree でチェックアウトできない
- worktree 内から他の worktree が使用中のブランチへの `git switch` は不可
- detached HEAD なら同じコミットを複数の worktree で参照可能（名前付きポインタが存在しないため競合しない）

### worktree の配置

`~/.local/share/gozd/worktrees/<repoName>-<hash>/` に配置する。リポジトリ外なので `.gitignore` の変更は不要。ディレクトリ名は `realpath` 後の絶対パスの SHA-256 ハッシュ（先頭12文字）で一意に識別する。

```text
~/projects/gozd/                                  ← main（メインディレクトリ）
~/.local/share/gozd/worktrees/gozd-a1b2c3d4e5f6/
├── 20260315_143000/                              ← feature-a
└── 20260316_001435/                              ← fix-bug
```

## UI 構成

### ネイティブ chrome（titlebar / toolbar）

macOS 26 Tahoe の Liquid Glass を有効化するため、Window scene の chrome を以下の構造で運用する。

- **Window 角丸**: `.toolbar { ToolbarItem(...) }` を 1 つ以上載せることで Tahoe の「Windows with toolbars use a larger radius」（WWDC25 310）に倒し、外枠を Liquid Glass 仕様の大半径角丸にする
- **Titlebar 暗色化**: Liquid Glass titlebar は背後コンテンツの輝度をサンプルして light / dark を自動 flip する（WWDC25 219）。gozd は WebView を `ignoresSafeArea(.container, edges: .top)` で titlebar 下に潜らせ、`.webViewContentBackground(.hidden)` で WebView 自身の opaque white default を消し、`.background(Color.black)` を敷くことで titlebar が dark variant に倒れる
- **Color scheme**: `ContentView` に `.preferredColorScheme(.dark)` を当て、NSAppearance 経由で traffic light / toolbar item の文字色等も dark mode 仕様に揃える
- **Toolbar item（principal）**: 現在 active な repo / worktree を `"repoName · branchName"` 形式で表示。renderer 側 `useTitleContextSync` composable が `repoStore.selectedRepo` + `selectedDir` を watch し、`rpcWindowSetTitleContext` で native に push する。native 側は `@Observable` な `TitleContext.shared.text` を保持し、`ContentView` の `ToolbarItem(.principal)` がそれを表示する
- **Glass capsule の除去**: `ToolbarItem(.principal)` の Text は非対話的なため `.sharedBackgroundVisibility(.hidden)` を付けて、HIG の「Non-interactive items should avoid the glass material」（WWDC25 310）に従う

### サイドバー（左端）

ウィンドウ内に同居する repo / dir 全体のナビゲーション。常時表示（git 管理外の dir でも表示される）。

構造:

- **トップツールバー**:
  - 左にビューモードトグル: アクティブな worktree のターミナル / 動いている Claude ターミナル一覧
  - 右に時計と編集モードトグル
- **repo セクション一覧**: 設定された並び順で同居中の全 repo / dir を縦に **並列展開**。セクション単位で折りたたみ可能。編集モード中は drag-drop で並び替え
- **Add directory ボタン**: 編集モード時のみリスト末尾に表示。クリックでネイティブのフォルダ選択ダイアログを開き、ユーザーが選んだ任意のディレクトリ（git 管理下 / 外問わず）を既存ウィンドウに追加する

各 repo セクションの中身:

- ヘッダ: 展開トグル + folder アイコン（git / 非 git で区別）+ repo 名。編集モード中は ✕ で repo 解除
- worktree カード列: main worktree を先頭に固定し、その後は `git worktree list` の順を維持。Claude state による並び替えはしない（位置の安定性を優先）
- 末尾に新規 worktree 作成ボタン

各 worktree カード:

- ヘッダ: branch アイコン + ブランチ名 + git 変更ファイル数バッジ（modified / added / deleted / untracked）+ upstream に対する ahead / behind 表示（上下矢印 + 数値）+ メニュー
- 配下のタスク行: 1 task ＝ 1 行。task は永続オブジェクト（PR / issue picker 由来 or 手動作成）。Claude session は task に attach する短命属性として表現する
  - 行頭アイコンで `working / asking / done / idle / resumable / not-started` の 6 状態を識別
  - 経過時間（相対時刻）は全 state で常時表示
  - バブルは `done` / `asking` 限定。`done` は応答テキストの抜粋、`asking` はツール承認要求の抜粋
  - task は作成順の append で固定（state による並び替えはしない）

### ビュー切り替え

- **一覧ビュー**（サイドバーのルート）: 各 worktree のターミナルが並ぶ。全体の作業状況を俯瞰できる
- **詳細ビュー**（worktree 選択時）: ターミナル（分割可）、ファイルツリー、プレビュー（右端、開閉可）のフル構成。現在の MainLayout に相当する

## 監視 / データ取得ポリシー

複数 repo 同居でも全部の状態をリアルタイム同期するとコストが重い。watch / fetch を範囲別に分けて運用する:

| 項目                                                                              | 範囲                     | 取得トリガー                                                                                                |
| --------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| FS watch（fsChange / gitStatusChange / branchChange / worktreeChange push event） | 選択中 dir のみ          | `selectedDir` の watcher が dir 切替時に `rpcFsWatch` / `rpcFsUnwatch` で付け替え                           |
| filer ツリー                                                                      | 選択中 dir のみ          | FS watch event                                                                                              |
| git status                                                                        | 選択中 dir のみ          | FS watch event **または** その dir に紐づく PTY の Claude state 変化（done / asking 等への遷移）            |
| PTY                                                                               | 全 dir 並列              | 起動時に spawn、worktree 削除 / 明示 kill まで維持                                                          |
| Claude status                                                                     | 全 dir / 全 PTY          | hook events を常時受信（`claudeStatusByPtyId` が ptyId キーで保持）                                         |
| サイドバーの worktrees / branches                                                 | 取得時のスナップショット | `gozdOpen` 受信時に fetch、選択中 repo の push event で再 fetch（非選択 repo は明示リフレッシュまで stale） |

設計の根拠:

- ファイルツリーを表示するのは選択 dir だけ → FS watch も同じく選択 dir だけで十分
- Claude が動く dir では Claude の状態遷移をシグナルとして git status を再取得すれば、FS watch を増やさなくても作業完了直後に変更ファイルが反映される
- PTY と Claude status は全 repo で並列維持（重要度が高く、止めると作業が壊れる）

## 並列作業の独立性

各 worktree は完全に独立した環境として機能する:

- ファイルシステムが独立（`node_modules/`、`dist/`、`.vite/` 等）
- dev サーバーを独立して起動できる（ポートは自動で空きポートにフォールバック）
- Claude Code のセッションが独立（cwd が異なるため）
- ターミナルセッションが独立

人間が main で確認作業をしても、各 worktree の Claude の作業には影響しない。

ターミナル出力のファイルパスをクリックでプレビューに表示する機能により、各 worktree 内のファイル確認がスムーズに行える。

## ビュー状態の保持

worktree を切り替えても以下のビュー状態は破棄せず保持する:

- ターミナルセッション（PTY プロセスは裏で動き続ける）

これらは表示・非表示の切り替えのみ行い、再生成しない。

ファイラーのツリー展開状態とプレビュー対象の選択ファイルは worktree 切替時にクリアされる。前者は単数 state のため `dir` の watch でツリーが再ロードされる結果として展開状態が失われ、後者は `useWorktreeStore` 側で `dir` が変わった瞬間に `selection` / `initialSelection` を `flush: "sync"` の watch で undefined にリセットする。`setOpen` を経由しない `selectedDir` の変更（例: `useRepoStore.removeRepo` で active repo が消えた場合のフォールバック）でも同様にクリアされる。

### workspace-scoped な状態管理（部分実装）

> [!NOTE]
> ターミナル（`useTerminalStore.layoutsByDir`）は dir ごとの保持を実装済み。ファイラー展開状態は単数 state で、選択 dir 切替時に再取得する設計。プレビュー選択は単数 state かつ意図的に切替時クリアの設計。

`useRepoStore` で複数 repo を保持する基盤は整ったが、各 repo の filer 展開状態は per-dir に持っていないため、worktree を切り替えるたびに失われる。プレビュー選択は意図的に切替時クリアの設計（上記参照）。

切り替え速度より状態保存を優先する場合: ファイラーも `Map<dir, State>` 化し、参照先切替で復元する。
取得コストが軽くシンプルさを優先する場合: 現状（FS watch event で再取得）のまま。

優先度は実利用での体感次第。

対象:

- ファイラー: 展開状態、スクロール位置

### ターミナルのスクロールバック永続化（未実装）

アプリ再起動時にターミナルの内容を復元するため、PTY セッション終了時にスクロールバックをディスクに保存する。復元時は読み取り専用で表示し、新しい PTY セッションを開始する。

### Claude セッションの resume 復元（実装済み）

ターミナル全体のスクロールバックは保存しない代わりに、Claude Code セッションの sessionId を `tasks.json` の `task.session_id` に持つ（SSOT。専用ストアは持たない）。`SessionStart` hook は CLI 経由で `session_id` を渡し、`attachSession` で「同 worktree の sessionId 空 + createdAt 最新の task」に attach する（無ければ新規 task を作る）。

アプリを再起動して worktree を選択（visit）すると、`rpcResumableSessionList`（導出ロジックは `TaskStore.resumableSessionIds`）が `worktreeDir == dir && sessionId != "" && !closedByUser` を満たす task の sessionId を返す。その数だけ leaf を horizontal split で並べ、各 leaf の PTY spawn 時に `GOZD_RESUME_CLAUDE_SESSION` を env に注入する。gozd の zsh init がこの env を見て `claude --resume <sessionId>` を 1 回だけ実行する。

resume 対象集合 (`sessionId != "" && !closedByUser`) の不変条件:

- **live session も条件上は含まれる**（live は `attachSession` で `closedByUser=false`）。ただし `visit` は未訪問 worktree の初回オープンでのみ走るため、同一プロセス内では visit 時点で live leaf がまだ無く二重 resume は構造的に起きない。dev / stable 同時起動で永続データを共有するケース（[architecture.md](./architecture.md#データ永続化) の WARNING）では一方の live session を他方が resume しうるが、共有データ前提として許容する
- **closed task の ghRef 再選択で集合に復帰する**。`add`（PR/issue picker 再選択）は同 worktreeDir + 同 ghRef の closed task を `closedByUser=false` に再活性化し、sessionId は保持する。結果その task は集合に戻り、次回 visit で前回 session を自動 resume する（閉じた PR を再選択して作業を継続する流れと一貫。dead なら下記 fallback に倒れる）

resume 可能なセッションはサイドバーの TaskRow に `resumable` / `closed` state アイコンとして表示する（判定は [task.md](task.md)）。worktree 単位の集計バッジは出さない (TaskRow が task 1 件単位で正確に状態を出すため、wt 行に集計を出すと同じ情報が二重表示になる)。Claude 以外のターミナルは保存対象ではない。

#### resume 対象集合から task が外れる経路

resume 対象集合 (`sessionId != "" && !closedByUser`) から task が外れる経路は 4 つ。決定点は **ユーザーの明示的操作 / Claude の明示的終了 / resume 失敗の reactive 検出** に置き、PTY exit そのものは契機にしない。task 本体は削除せず `closedByUser=true` を立てる（or sessionId を空に戻す）だけなので、サイドバーには `closed` / `not-started` として残り、明示削除はユーザーの ⋮ メニュー or worktree 削除 cascade を待つ。アプリ終了時は renderer ごと死んで `unregisterPane` が走らないため、`closedByUser=false` のまま残り次回 resume できる。proactive な transcript 存在チェックはしない (Claude 側の transcript 仕様への依存を避けるため)。

| 経路                                                                             | 契機                                                                                             | 動作                                                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| renderer の `unregisterPane`（terminal.closePane / resetLayout / worktree 削除） | ユーザーの明示的 pane 削除                                                                       | `rpcClaudeSessionRemoveByPty({ ptyId, worktreePath })` → native が `PTYRegistry` の per-pty sessionId を解決して `detachSession` |
| `SessionEnd` hook                                                                | Claude 自身の正規終了（`/exit` 等）                                                              | CLI 経由で `detachSession`（sessionId は保持、`closedByUser=true`）                                                              |
| 同 PTY 内の `/clear` / `--resume`                                                | 新 `session-start` 到達時、旧 sessionId と比較                                                   | 旧 ID を `detachSession`                                                                                                         |
| resume 失敗検出 (`removeByPty` 経路)                                             | spawn 時 `GOZD_RESUME_CLAUDE_SESSION` 期待 sid が SessionStart hook 不達のまま pane が閉じられた | `clearDeadSession` で sid を空に + `closedByUser=true`（task 本体は残す）                                                        |

削除 RPC は ptyId をキーに発火する。renderer は `paneRegistry` に保持している ptyId をそのまま渡すだけで、hook 到達順との race を排除できる。native の `PTYRegistry` は `ptyId → sessionId` マッピングを保持し、`clearAssociations` で `worktreePath` も併せて消すことで、削除 RPC 受信後に到達した late `session-start` hook を `applyClaudeSessionHook` の guard で構造的に弾く（弾いた事象は stderr に「late session-start ... after removeByPty; skipping」として観察可能）。

resume 失敗検出は、`PTYRegistry` が spawn 時に `env["GOZD_RESUME_CLAUDE_SESSION"]` を per-pty に保存しておき、SessionStart hook 着弾時に同じ sid なら消費 (= 成功)、`removeByPty` 受信時に残っていれば失敗と判定する仕組み。これにより 30 日以上経過した古い sid (Claude 側で transcript rotation 済み) や、`~/.claude/projects/` 手動クリーンアップ後の stale な sid を、ユーザーがクリックして失敗を確認した時点で gozd 側からも掃除する。
