# Desktop（メインプロセス）

Electrobun 上の Bun ランタイムで動作するメインプロセス。PTY、ファイル監視、LSP、RPC ハンドラ、ソケットサーバーを管理する。

## パス検証

renderer からの RPC リクエストで受け取るパスを検証し、ワークスペース外へのアクセスを防止する。`apps/desktop/src/security.ts` に3系統の関数を用意し、操作の意味に応じて使い分ける。

### Git 論理パス — `resolveGitPath(root, relPath)`

- `git show HEAD:path` や `git diff HEAD -- path` など、Git のオブジェクト操作に使用
- `realpath` は使わない。Git は repo 内の論理パスで操作するため、symlink 先の実パスは関係ない
- `path.resolve` + `path.relative` による lexical チェックで `../` 脱出を防ぐ

| 呼び出し元                    | 用途                       |
| ----------------------------- | -------------------------- |
| `gitShowFile`                 | `git show HEAD:relPath`    |
| `gitDiffFile`                 | `git diff HEAD -- relPath` |
| ファイルサーバー `/git/` 経路 | `git show HEAD:relPath`    |

### 既存 FS パス — `resolveExistingFsPath(root, relPath)`

- ファイル読み込みやディレクトリ読み込みなど、既存パスへのアクセスに使用
- `realpath` で symlink を解決し、実パスが root 配下であることを確認する
- root 自体（`relPath="."` → `relative=""`）も許容する

| 呼び出し元                   | 用途                 |
| ---------------------------- | -------------------- |
| `fsReadFile`                 | ファイル読み込み     |
| `fsReadDir`                  | ディレクトリ読み込み |
| `removeWorktree`             | worktree 削除        |
| ファイルサーバー `/fs/` 経路 | ファイル配信         |

### 未存在 FS パス — `resolveCreatableFsPath(root, relPath)`

- 新規ディレクトリやファイルの作成先を検証する場合に使用
- 対象パスはまだ存在しないため `realpath` できない。代わりに親ディレクトリを `realpath` で検証する
- 親の実パスが root 配下であれば、作成先として安全と判断する

| 呼び出し元    | 用途          |
| ------------- | ------------- |
| `addWorktree` | worktree 作成 |

## プロトコル制限

`isAllowedProtocol()` で外部 URL を `https:` / `http:` のみに制限する。`openExternal` メッセージで使用。
