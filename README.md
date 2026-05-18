# gozd 🌲

**Git Orchestrated Zone for Development**

ターミナル + worktree 管理を軸に、Git グラフやファイル差分まで束ねた AI エージェント並列開発デスクトップアプリ。

- 🌳 マルチ repo × マルチ worktree を 1 ウィンドウに
- ✨ ボタンや PR / issue 選択でサクッと worktree 作成
- 🤖 worktree ごとに Claude を並列実行
- 🔔 各エージェントの状態がひと目で分かる
- 🎙️ 確認待ち・完了は音声でも通知
- 🗂️ Git グラフ × ファイルツリー × 変更一覧 × 差分プレビューが連動する IDE 的ビュー

gozd はスロベニア語で「森」（/ɡɔ́st/、「ゴスト」）。

## 特徴

### Claude を並列で走らせる

- 1 ウィンドウに複数の repo / worktree を並べて、それぞれで Claude を同時に動かせる
- サイドバーのボタンで worktree をサクッと作成
- PR / issue から直接 worktree 作成。レビューや着手がワンクリックで独立した作業スペースになる
- 「作業中 / 確認待ち / 完了」が経過時間つきでサイドバーに並ぶ
- 確認待ち・完了は VOICEVOX が読み上げ。別ウィンドウにいても気付ける
- 各 worktree のブランチに紐づく PR の状態もサイドバーに

### worktree 運用

- 作業中の Claude セッション ID はアプリを閉じても保存され、サイドバーからクリックで復帰できる
- サイドバーに「repo → worktree → Claude タスク」の階層が縦に並び、どこで何が走っているか一画面で把握できる
- `.env.local` みたいな Git 管理外のファイルもメインから自動リンクで共有

### Git グラフから差分まで一気通貫

- 選んだ worktree のコミット履歴をグラフ表示。タグや refs もバッジで
- グラフでコミットを選ぶ → 変更ファイル一覧 → 差分プレビュー、と滑らかに辿れる
- 2 つのコミットを範囲指定すれば、まとめた差分も見られる

### CLI

- `gozd <path>` で開く。すでに開いていればフォーカス、未起動なら自動で立ち上げ
- 普段のターミナルで `gozd` を打つだけで、その場所が gozd のセッションに合流する

## 開発時

事前に [mise](https://mise.jdx.dev/) を導入しておく。

```bash
mise install
pnpm install
pnpm run dev
```

## ビルド版

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

初回起動時はサイドバーが空の状態。repo を登録するには:

- サイドバー右上の編集メニューから repo を選んで追加
- もしくはターミナルで `gozd <repo のパス>` を実行して開く

追加後はサイドバーから worktree を作って作業を始める。
