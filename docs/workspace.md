# ワークスペース設計

並列プロジェクト・並列 worktree による開発環境の管理。

## コンセプト

- orkis はオーケストレーターであり、複数の Claude エージェントが並列に作業することを前提とする
- git worktree を活用し、ブランチごとに独立した作業環境を提供する
- 人間は main で確認作業を行い、各 worktree では Claude が独立して開発する

## 階層構造

```text
プロジェクト一覧
└── プロジェクト（git リポジトリ）
    ├── main（メインディレクトリ = 参照・確認用）
    ├── wt-xxxx (feature-a)
    ├── wt-yyyy (fix-bug)
    └── ...
```

## プロジェクト（未実装）

> [!NOTE]
> 以下は将来の構想であり、現時点では実装されていない。

- `~/.config/orkis/projects.json` に登録済みプロジェクトディレクトリを永続化する
- `orkis <dir>` でディレクトリを開くと自動的にリストに登録される
- CLI はパスをそのまま送信し、デスクトップ側で `git rev-parse --show-toplevel` によりリポジトリルートに解決する
- git リポジトリでないディレクトリが指定された場合の扱いは未定

## Worktree 運用ルール

### main ブランチ

- メインディレクトリ（clone 元）が main の worktree として機能する
- main は参照・確認専用。dev サーバーの起動や build は自由に行える
- main で直接コミットしない。Claude も main では作業しない

### 作業用 worktree

- 新しい作業を始めるときは必ず worktree を作成する
- worktree 作成時にランダムな一時ブランチ名（`wt-<短いID>`）を自動生成する
- ブランチ名は `git branch -m <名前>` でいつでもリネームできる（worktree の紐づけは追従する）
- PR 作成時にリネームを促す導線を用意する。検証だけで終わる worktree は名前を付けずに削除してもよい
- 各 worktree は独立したファイルシステムを持ち、`pnpm install` / `pnpm dev` / `pnpm build` を独立して実行できる

### git worktree の制約

- ブランチと worktree は 1:1。同じブランチを複数の worktree でチェックアウトできない
- worktree 内から他の worktree が使用中のブランチへの `git switch` は不可
- detached HEAD なら同じコミットを複数の worktree で参照可能（名前付きポインタが存在しないため競合しない）

### worktree の配置

デフォルトは `.orkis/worktrees/`。`.orkis/` は `.gitignore` に追加する。配置場所は設定で変更可能にする。

```text
~/projects/orkis/                               ← main（メインディレクトリ）
~/projects/orkis/.orkis/worktrees/wt-a1b2/      ← feature-a
~/projects/orkis/.orkis/worktrees/wt-c3d4/      ← fix-bug
```

## UI 構成

### サイドバー（左端）

プロジェクト一覧 → プロジェクト選択 → ブランチ・worktree 一覧の階層ナビゲーション。

- **プロジェクト一覧**: 登録済みプロジェクトを表示。選択するとそのプロジェクトの worktree 一覧に遷移する
- **ブランチ一覧**: ローカルブランチを表示し、worktree 化されているかどうかを区別する
  - worktree あり → 選択すると詳細ビューに切り替わる
  - worktree なし → 選択すると worktree 作成の導線を表示する

### ビュー切り替え

- **一覧ビュー**（プロジェクト選択時）: 各 worktree のターミナルが並ぶ。全体の作業状況を俯瞰できる
- **詳細ビュー**（worktree 選択時）: ファイルツリー、プレビュー、ターミナルのフル構成。現在の MainLayout に相当する

## 並列作業の独立性

各 worktree は完全に独立した環境として機能する:

- ファイルシステムが独立（`node_modules/`、`dist/`、`.vite/` 等）
- dev サーバーを独立して起動できる（ポートは自動で空きポートにフォールバック）
- Claude Code のセッションが独立（cwd が異なるため）
- ターミナルセッションが独立

人間が main で確認作業をしても、各 worktree の Claude の作業には影響しない。

## ビュー状態の保持

プロジェクトや worktree を切り替えて非表示になっても、各 worktree のビュー状態は破棄せず保持する:

- ファイルツリーの展開状態・選択中のファイル
- プレビュー内容
- ターミナルセッション（PTY プロセスは裏で動き続ける）

切り替え時は表示・非表示の切り替えのみ行い、再生成しない。この方針はターミナルバックエンド（xterm / ghostty）の切り替えにも適用する。
