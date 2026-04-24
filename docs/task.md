# Task 管理

worktree の前段として作業計画を管理する。Task と worktree を 1:1 で紐づけ、worktree の表示名として Task タイトルを使う。

## データモデル

```typescript
interface Task {
  id: string; // UUID (crypto.randomUUID)
  body: string; // git commit 形式: 一行目=タイトル、残り=本文
  worktreeDir?: string; // 紐づいた worktree のパス（未着手なら undefined）
  prNumber?: number; // 紐づく PR 番号（PR から worktree を作成した場合に設定）
  issueNumber?: number; // 紐づく issue 番号（issue から worktree を作成した場合に設定）
  createdAt: string; // ISO 8601
}
```

- `body` は git commit メッセージと同じ構造。一行目をタイトルとして表示に使う
- `body` が空の場合は「(無題)」と表示する

## 保存

`~/.config/gozd/projects/<エンコード済みパス>/tasks.json` に `Task[]` を保存する。

```text
~/.config/gozd/
  app-state.json
  projects/
    -Users-miyaoka-ghq-github-com-miyaoka-gozd/
      tasks.json
```

- パスエンコードは Claude Code と同じ方式（`/` → `-`、先頭 `-`）
- プロジェクトディレクトリは Task 以外のプロジェクト固有データ（設定、worktree スクリプト等）の置き場としても使う

## ライフサイクル

### worktree に Task を追加

`⋮` メニュー → "Edit task" でインライン編集。Task がなければ新規作成入力欄を表示する。ターミナルタイトル変更時にも Task が自動作成される（`useSidebarData.ts` のタイトル同期）。

### PR から worktree 作成

```text
"Workspace: Open Pull Request" → PR 選択 → worktree 作成 + Task 作成（body=PR タイトル、prNumber=PR 番号）
```

- `prNumber` が設定された Task は、サイドバーで `#番号` をタイトルの前にプレフィックス表示する

### Issue から worktree 作成

```text
"Workspace: Open Issue" → issue 選択 → worktree 作成（タイムスタンプブランチ） + Task 作成（body=issue タイトル、issueNumber=issue 番号）
```

- PR と異なり既存ブランチがないため、タイムスタンプ名で新規ブランチを作成する
- `issueNumber` が設定された Task は、`prNumber` と同様にサイドバーで `#番号` をプレフィックス表示する

### 削除・クリーンアップ

| トリガー                                         | 挙動                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| WORKTREES `[⋮]` → "wt を削除"                    | worktree 削除 + Task 削除                                                    |
| 外部で worktree 消失（`git worktree remove` 等） | `gitWorktreeList` 取得時に存在しない `worktreeDir` を検出し、Task を自動削除 |

## サイドバー UI

```text
ROOT
  🏠 main

WORKTREES
  ● feature-aの実装    [M2 A1]   [⋮]
  ● (無題)                        [⋮]

BRANCHES
  ○ feature-old                   [⋮]
```

### セクション構成

| セクション | 内容                                               |
| ---------- | -------------------------------------------------- |
| ROOT       | リポジトリルート（main）。メニューなし             |
| WORKTREES  | worktree 一覧。Task タイトルまたはブランチ名で表示 |
| BRANCHES   | worktree 化されていないローカルブランチ            |

### `[⋮]` メニュー

**WORKTREES 行:**

- Task を編集
- wt を削除

**BRANCHES 行:**

- Worktree 化

### Task 編集

`[⋮]` → "Task を編集" でサイドバー内にインライン展開する。テキストの編集のみ行う。

```text
WORKTREES
  🏠 main
  ▼ feature-aの実装    [×]
  ┌─────────────────┐
  │feature-aの実装   │
  │                  │
  │認証モジュールを  │
  │分離して...       │
  │         [保存]   │
  └─────────────────┘
  ● (無題)           [⋮]
```

## RPC

### 新規追加

```text
taskList:               undefined → Task[]
taskAdd:                { body, worktreeDir?, prNumber?, issueNumber? } → Task
taskUpdate:             { id, body } → Task
taskRemove:             { id } → void
createWorktreeWithTask: { id, worktreeDir, branch } → { task, worktree, dir, fileServerBaseUrl }
```

### 既存変更

- `createWorktree`: worktreeDir と branch を renderer 側から指定し、switchDir 相当の処理も統合（worktree + dir + fileServerBaseUrl を返す）
- `gitWorktreeList`: 各 worktree に紐づく Task を含める
