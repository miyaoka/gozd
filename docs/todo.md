# Todo 管理

worktree の前段として作業計画を管理する。Todo と worktree を 1:1 で紐づけ、worktree の表示名として Todo タイトルを使う。

## データモデル

```typescript
interface Todo {
  id: string; // UUID (crypto.randomUUID)
  body: string; // git commit 形式: 一行目=タイトル、残り=本文
  worktreeDir?: string; // 紐づいた worktree のパス（未着手なら undefined）
  createdAt: string; // ISO 8601
}
```

- `body` は git commit メッセージと同じ構造。一行目をタイトルとして表示に使う
- `body` が空の場合は「(無題)」と表示する

## 保存

`~/.config/orkis/projects/<エンコード済みパス>/todos.json` に `Todo[]` を保存する。

```text
~/.config/orkis/
  app-state.json
  projects/
    -Users-miyaoka-ghq-github-com-miyaoka-orkis/
      todos.json
```

- パスエンコードは Claude Code と同じ方式（`/` → `-`、先頭 `-`）
- プロジェクトディレクトリは Todo 以外のプロジェクト固有データ（設定、worktree スクリプト等）の置き場としても使う

## ライフサイクル

### Todo 作成 → worktree 化

```text
[+ New todo] → body 入力 → Todo 保存（worktreeDir なし）
     ↓
Todo の [⋮] → "Worktree 化" → worktree 作成 + worktreeDir 紐づけ
```

### 直接 worktree 作成

```text
[New worktree] → worktree 作成 + 空 body の Todo 自動生成・紐づけ
```

### 削除・クリーンアップ

| トリガー                                         | 挙動                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| WORKTREES `[⋮]` → "wt を削除"                    | worktree 削除 + Todo 削除                                                    |
| TODOS `[⋮]` → "Todo を削除"                      | Todo 削除（worktree なし）                                                   |
| 外部で worktree 消失（`git worktree remove` 等） | `gitWorktreeList` 取得時に存在しない `worktreeDir` を検出し、Todo を自動削除 |

## サイドバー UI

```text
ROOT
  🏠 main

WORKTREES
  ● feature-aの実装    [M2 A1]   [⋮]
  ● (無題)                        [⋮]

TODOS
  □ バグ修正                      [⋮]
  [+ New todo]

BRANCHES
  ○ feature-old                   [⋮]
```

### セクション構成

| セクション | 内容                                       |
| ---------- | ------------------------------------------ |
| ROOT       | リポジトリルート（main）。メニューなし     |
| WORKTREES  | Todo 紐づき済みの worktree。タイトルで表示 |
| TODOS      | 未着手の Todo（worktreeDir なし）          |
| BRANCHES   | worktree 化されていないローカルブランチ    |

### `[⋮]` メニュー

**WORKTREES 行:**

- Todo を編集
- wt を削除

**TODOS 行:**

- Worktree 化
- Todo を編集
- Todo を削除

**BRANCHES 行:**

- Worktree 化

### Todo 編集

`[⋮]` → "Todo を編集" でサイドバー内にインライン展開する。

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
todoList:   { repoRoot } → Todo[]
todoAdd:    { repoRoot, body } → Todo
todoUpdate: { repoRoot, id, body } → Todo
todoRemove: { repoRoot, id } → void
todoStart:  { repoRoot, id } → { todo: Todo, worktree: WorktreeEntry }
```

### 既存変更

- `gitWorktreeAdd`: レスポンスに自動生成した Todo を含める
- `gitWorktreeList`: 各 worktree に紐づく Todo を含める
