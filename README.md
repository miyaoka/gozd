# gozd 🌲

**Git Orchestrated Zone for Development**

ターミナル + worktree 管理を軸に、Git グラフやファイル差分まで束ねた AI エージェント並列開発デスクトップアプリ。

- 🌳 マルチ repo × マルチ worktree を 1 ウィンドウに
- ✨ ボタンや PR / issue 選択でサクッと worktree 作成
- 🤖 worktree ごとに Claude を並列実行
- 🔔 各エージェントの状態がひと目で分かる
- 🎙️ 確認待ち・完了は音声でも通知
- 🗂️ Git グラフ × ファイルツリー × 変更一覧 × 差分プレビューが連動する IDE 的ビュー

gozd はスロベニア語で「森」（[ɡɔ́st]、「ゴスト」）。

## 動作環境

- macOS 26 Tahoe 以降
- zsh（PTY 起動時に gozd が zsh 初期化チェーンを差し込む前提）

## 特徴

### Claude を並列で走らせる

- 1 ウィンドウに複数の repo / worktree を並べて、それぞれで Claude を同時に動かせる
- サイドバーのボタンで worktree をサクッと作成
- PR / issue から直接 worktree 作成。レビューや着手がワンクリックで独立した作業スペースになる
- 各 worktree タスクの Claude 状態（作業中 / 確認待ち / 完了 / 再開可 など）と経過時間がサイドバーに並ぶ
- 「アクティブな worktree のターミナル」と「動いている Claude ターミナル一覧」をビュー切替で行き来でき、複数エージェントの様子を一画面で並べて見られる
- 確認待ち・完了は VOICEVOX が読み上げ。別ウィンドウにいても気付ける

### worktree 運用

- 過去に Claude を起動した worktree は session ID が保存され、サイドバーからクリックで `claude --resume` 起動
- サイドバーに「repo → worktree → Claude タスク」の階層が縦に並び、どこで何が走っているか一画面で把握できる
- `.env.local` など Git 管理外のファイルを worktree 作成時にメインから symlink で共有（対象パスはプロジェクト設定で指定）

### Git グラフから差分まで一気通貫

- 選んだ worktree のコミット履歴をグラフ表示。タグや refs もバッジで
- グラフでコミットを選ぶ → 変更ファイル一覧 → 差分プレビュー、と滑らかに辿れる
- 2 つのコミットを範囲指定すれば、まとめた差分も見られる
- 開いているブランチに紐づく open PR の番号が Git グラフ上の ref バッジに表示される（draft はグレー、それ以外は紫で区別）

## インストール

[mise](https://mise.jdx.dev/) でインストールする。

### canary（開発版）を追う

main への機能 merge ごとに自動リリースされる。

```bash
mise use -g 'github:miyaoka/gozd[prerelease=true]'
```

### stable のみを追う

手動リリースされる安定版だけを取得する。

```bash
mise use -g github:miyaoka/gozd
```

### 起動

```bash
gozd   # 初回起動で ~/Applications/Gozd.app に配置される
```

- `gozd` コマンドの起動時に `~/Applications/Gozd.app` へアプリが配置・更新される。Dock ピン留めと Spotlight 起動はこの固定パスで安定する
- 更新は `mise up` → 次回 `gozd` 起動時に反映（詳細は [docs/release.md](docs/release.md)）

`gozd` CLI で任意のパスを開く。アプリが未起動であれば自動で起動する。

```bash
gozd              # カレントディレクトリで開く
gozd docs         # docs ディレクトリで開く
gozd src/main.ts  # src/ で開き、main.ts を開く
```

## 使い方

初回起動時はサイドバーが空の状態。フォルダを登録するには:

- サイドバー右上の編集ボタンで編集モードに入り、末尾の `+ Add directory` から開きたいフォルダを選ぶ
- もしくはターミナルで `gozd <パス>` を実行する

追加後はサイドバーから worktree を作って作業を始める。

## 開発

[mise](https://mise.jdx.dev/) でツールチェインを揃え、依存を入れて開発ビルドを起動する。

```bash
mise install
pnpm install
pnpm run dev
```

パッケージした `.app` で検証する場合はソースからビルドする。生成されるのは local channel の
`Gozd Local.app` で、mise 配布の Gozd とは socket / bundle id が分かれており隣で同時起動できる
（[docs/release.md](docs/release.md)）。

```bash
pnpm run build:app   # out/mac-arm64/Gozd Local.app をパッケージング
pnpm run open:app    # 生成した .app を起動
```

electron-builder が成果物を `.app` 内へコピーするため、`.app` を更新するにはこの再パッケージが要る
（root の `pnpm run build` は各パッケージの成果物を作るだけで `.app` は更新しない）。
