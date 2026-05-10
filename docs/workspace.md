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

非 git ディレクトリも同じ仕組みで「project」として登録される。worktree 概念がないため、サイドバーの ROOT / WORKTREES / BRANCHES セクションは表示せず、repo 切替リストとターミナルのみが利用可能。

## アプリ状態の復元

`~/.config/gozd/app-state.json` に最後のウィンドウ状態を保存し、次回起動時に sidebar として hydrate する。dev / stable で同じファイルを共有する。

save の発火条件は `buildAppStateSnapshot()` のシリアライズ結果が前回と変化した時のみ。`worktrees` / `freeBranches` / `gitStatuses` / `task` などサイドバー描画用のデータは snapshot に含まれないため、git status push / `fetchRepo` / Task title 同期では save が走らない。発火するのは `dirOrder` / `collapsedRoots` / `selectedDir` / 各 repo の `repoName` / `isGitRepo` が実際に変化した時のみ。

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

### サイドバー（左端）

ウィンドウ内に同居する repo / dir 全体のナビゲーション。常時表示（git 管理外の dir でも表示される）。

上から順に:

- **repo 切替リスト**: `useRepoStore.dirOrder` 順に同居中の全 repo / dir を縦に並べる。git は `lucide--folder-git-2`、非 git は `lucide--folder` で区別。クリックで `selectedDir` を切り替える
- **Add directory ボタン**: native の `NSOpenPanel` を `/open/pickAndOpen` RPC 経由で起動し、ユーザーが選んだ dir を既存ウィンドウに追加する
- **repo 名ヘッダ**: 選択中 repo の表示名（編集可能、`renameSelectedRepo`）
- **ROOT / WORKTREES / BRANCHES セクション**: **git repo の時のみ表示**。選択中 repo の main worktree、worktree 一覧、worktree 化されていないブランチを表示
  - worktree 行: git 変更ファイル数（modified/added/deleted/untracked）をバッジ表示。Claude Code の状態（working/asking/done）を右上にアイコンで重ねて表示し、working 時は経過時間も表示。done は worktree クリックでクリアされる（既読消化）

非選択 repo の Claude セッションは終了せず並列で動き続けるため、サイドバー上のバッジで状態が見える形にする予定（現状未実装）。

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

プロジェクトや worktree を切り替えて非表示になっても、各 worktree のビュー状態は破棄せず保持する:

- ファイルツリーの展開状態・選択中のファイル
- プレビュー内容
- ターミナルセッション（PTY プロセスは裏で動き続ける）

切り替え時は表示・非表示の切り替えのみ行い、再生成しない。

### workspace-scoped な状態管理（部分実装）

> [!NOTE]
> ターミナル（`useTerminalStore.layoutsByDir`）と worktree 選択（`useWorktreeStore.selectionByDir`）は dir ごとの保持を実装済み。ファイラー展開状態・プレビューはまだ単数 state で、選択 dir 切替時に再取得する設計。

`useRepoStore` で複数 repo を保持する基盤は整ったが、各 repo の filer 展開・preview 状態は per-dir に持っていないため、worktree を切り替えるたびに失われる。

切り替え速度より状態保存を優先する場合: ファイラー/プレビューも `Map<dir, State>` 化し、参照先切替で復元する。
取得コストが軽くシンプルさを優先する場合: 現状（FS watch event で再取得）のまま。

優先度は実利用での体感次第。

対象:

- ファイラー: 展開状態、選択パス、スクロール位置
- プレビュー: 表示中のファイル、スクロール位置

### ターミナルのスクロールバック永続化（未実装）

アプリ再起動時にターミナルの内容を復元するため、PTY セッション終了時にスクロールバックをディスクに保存する。復元時は読み取り専用で表示し、新しい PTY セッションを開始する。

### Claude セッションの resume 復元（実装済み）

ターミナル全体のスクロールバックは保存しない代わりに、Claude Code セッションの sessionId だけを worktree 単位で永続化する（`~/.config/gozd/projects/<projectKey>/claude-sessions.json`）。`SessionStart` / `SessionEnd` hook は CLI 経由に切り替えており、stdin で渡される `session_id` / `transcript_path` を取得して保存・削除する。

アプリを再起動して worktree を選択（visit）すると、保存されたセッション数だけ leaf を horizontal split で並べ、各 leaf の PTY spawn 時に `GOZD_RESUME_CLAUDE_SESSION` を env に注入する。gozd の zsh init がこの env を見て `claude --resume <sessionId>` を 1 回だけ実行する。

サイドバーの worktree 行には「saved - live」で算出した resume 可能セッション数のバッジ（rotate-cw アイコン）を出し、未訪問 worktree のうち resume すべきものを一目で識別できるようにしている。worktree を visit して live が saved に追いつくと自然にバッジが消える。Claude 以外のターミナルは保存対象ではない。
