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

初回はビルドしてアプリを起動する。

```bash
pnpm run bootstrap
```

起動したアプリで `Shift+Cmd+P` でコマンドパレットを開き、`Shell Command: Install 'gozd' command in PATH` を実行すると `~/.local/bin/gozd` に CLI への symlink が作られる（`~/.local/bin` が PATH に通っている前提）。アンインストールは `Shell Command: Uninstall 'gozd' command from PATH`。

以降の再ビルドは `pnpm run build`。symlink は `.app` 内 wrapper を指すため、ビルドし直しても張り替え不要（`.app` を別の場所に移したときのみ install をやり直す）。

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

事前に以下を導入しておく。

- Xcode 26 以降（Swift 6.2 / macOS 26 SDK が含まれる）
- [mise](https://mise.jdx.dev/)（残りのツールチェインを `mise install` でまとめて揃える）

```bash
mise install
pnpm install
pnpm run dev
```
