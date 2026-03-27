# Task 管理

worktree の前段として作業計画を管理する。Task と worktree を 1:1 で紐づけ、worktree の表示名として Task タイトルを使う。

## データモデル

```typescript
interface Task {
  id: string; // UUID (crypto.randomUUID)
  body: string; // git commit 形式: 一行目=タイトル、残り=本文
  worktreeDir?: string; // 紐づいた worktree のパス（未着手なら undefined）
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

### Task 作成 → worktree 化

```text
[+ New task] → body 入力 → Task 保存（worktreeDir なし）
     ↓
Task の [⋮] → "Worktree 化" → worktree 作成 + worktreeDir 紐づけ
```

### 直接 worktree 作成

```text
[New worktree] → Task 入力パネル表示（デフォルトでタイムスタンプ入力済み） → Task 作成 + worktree 作成・紐づけ
```

### 削除・クリーンアップ

| トリガー                                         | 挙動                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| WORKTREES `[⋮]` → "wt を削除"                    | worktree 削除 + Task 削除                                                    |
| TASKS `[⋮]` → "Task を削除"                      | Task 削除（worktree なし）                                                   |
| 外部で worktree 消失（`git worktree remove` 等） | `gitWorktreeList` 取得時に存在しない `worktreeDir` を検出し、Task を自動削除 |

## サイドバー UI

```text
ROOT
  🏠 main

WORKTREES
  ● feature-aの実装    [M2 A1]   [⋮]
  ● (無題)                        [⋮]

TASKS
  □ バグ修正                      [⋮]
  [+ New task]

BRANCHES
  ○ feature-old                   [⋮]
```

### セクション構成

| セクション | 内容                                       |
| ---------- | ------------------------------------------ |
| ROOT       | リポジトリルート（main）。メニューなし     |
| WORKTREES  | Task 紐づき済みの worktree。タイトルで表示 |
| TASKS      | 未着手の Task（worktreeDir なし）          |
| BRANCHES   | worktree 化されていないローカルブランチ    |

### `[⋮]` メニュー

**WORKTREES 行:**

- Task を編集
- wt を削除

**TASKS 行:**

- Worktree 化
- Task を編集
- Task を削除

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
taskAdd:                { body, worktreeDir? } → Task
taskUpdate:             { id, body } → Task
taskRemove:             { id } → void
createWorktreeWithTask: { id, worktreeDir, branch } → { task, worktree, dir, fileServerBaseUrl }
```

### 既存変更

- `createWorktree`: worktreeDir と branch を renderer 側から指定し、switchDir 相当の処理も統合（worktree + dir + fileServerBaseUrl を返す）
- `gitWorktreeList`: 各 worktree に紐づく Task を含める
