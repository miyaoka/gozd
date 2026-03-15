# orkis 設計文書

> [!NOTE]
> このドキュメントは初期の構想段階で書かれたものであり、実装が進んだ現在は実際の仕様と合っていない箇所が多い。各機能の実装仕様は個別のドキュメント（`filer.md`, `preview.md` 等）を参照すること。

## 背景

- AI エージェント（Claude Code 等）が開発の主役になりつつあるが、既存ツールは「人間がコードを書く」前提で設計されている
- VS Code はコード編集中心の画面構成で、複数エージェントの並行管理やフィードバックループの概念がない
- 現状の Claude Code は1セッション=1エージェント=1リポジトリで、セッション間の関連性を人間が頭の中で管理している

## コンセプト

- **エディタではなくオーケストレーター**: コード編集ペインは不要。エージェントが書く。確認は差分ビューで十分
- **Goal 駆動のフィードバックループ**: Goal を設定し、Plan を作り、エージェントに実装させ、Review して Goal 達成度を検証し、未達なら Plan を修正して再実装する
- **複数リポジトリの統合管理**: front/backend 等の複数リポジトリにまたがるタスクを1つの Todo として統合的に管理する
- **ペインによる文脈の可視化**: Todo を選択すれば、そのタスクに紐づく Plan・実装・Review の状態が一覧できる

## ワークフロー

```
Todo
 └── Goals（受け入れ基準）
      └── Master Plan（包括的な設計）
           ├── Sub Plan: repo-A
           └── Sub Plan: repo-B
                └── Implementation（エージェント実行）
                     └── Review（Goal 達成度の検証）
                          ├── 全 Goal 達成 → Done
                          └── 未達成 → Plan 修正 → 再実装
```

## 画面構成

```
┌─────────┬──────────────────────────────────────┐
│ Todos   │ ┌─ Plan ─┬─ Implement ─┬─ Review ─┐ │
│         │ │        │             │           │ │
│ ■ 認証  │ │ Goals  │ [frontend]  │ Goal達成  │ │
│ □ API   │ │        │ [backend]   │ 状況      │ │
│ □ UI    │ │ Master │ ← タブ切替  │           │ │
│         │ │ Plan   │             │ diff +    │ │
│         │ │        │ ターミナル   │ Plan 突き │ │
│         │ │ Sub    │ (claude)    │ 合わせ    │ │
│         │ │ Plans  │             │           │ │
│         │ └────────┴─────────────┴───────────┘ │
└─────────┴──────────────────────────────────────┘

Todo を切り替えると右側全体がそのTodoの状態に切り替わる
```

## データモデル

```typescript
interface Todo {
  id: string;
  title: string;
  status: "planning" | "implementing" | "reviewing" | "done";
  goals: Goal[];
  repos: string[];
  masterPlan: MasterPlan;
  implementations: Implementation[];
  reviews: Review[];
}

interface Goal {
  id: string;
  description: string;
  status: "pending" | "achieved" | "failed" | "revised";
}

interface MasterPlan {
  content: string; // マークダウン
  subPlans: SubPlan[];
  history: PlanRevision[]; // 修正履歴
}

interface SubPlan {
  repo: string; // 対象リポジトリのパス
  content: string;
}

interface Implementation {
  repo: string;
  mode: "auto" | "interactive";
  status: "running" | "waiting" | "done" | "failed";
  sessionId?: string; // Claude Code --resume 用
}

interface Review {
  goalResults: GoalResult[];
  diff: string;
  feedback: string;
  planRevision?: PlanRevision; // この Review から生まれた Plan 修正
}

interface GoalResult {
  goalId: string;
  status: "achieved" | "partial" | "not_started";
  evidence: string; // diff のどの部分が根拠か
}

interface PlanRevision {
  id: string;
  content: string;
  reason: string; // 修正理由
  createdAt: string;
}
```

## エージェント連携

### Claude Code CLI を利用

アプリは Claude Code を「表示・管理」するだけで、エージェントの実行自体には介入しない。

#### auto モード（-p）

```bash
claude -p "{Goals + Plan}" \
  --allowedTools "Read,Edit,Bash,Glob,Grep" \
  --output-format stream-json
```

stream-json でリアルタイム進捗を表示し、完了したら自動的に Review 工程へ。

#### interactive モード

ターミナルペインで `claude` を起動し、初期プロンプトに Plan を流し込む。ユーザーが途中で介入可能。

### CLI — desktop 間通信

CLI（`orkis` コマンド）と Electrobun メインプロセスは Unix ドメインソケット（`/tmp/orkis-${channel}.sock`）で通信する。プロトコルは NDJSON（改行区切り JSON）。

| コマンド             | メッセージ                         | 用途                             |
| -------------------- | ---------------------------------- | -------------------------------- |
| `orkis hook <event>` | `{ type: "hook", event, payload }` | Claude Code Hooks からの状態通知 |
| `orkis open <path>`  | `{ type: "open", dir, file? }`     | プロジェクトを開く               |

パス引数は CLI 側で解決される:

- ディレクトリ → `{ dir: absolutePath }`
- ファイル / 存在しないパス → `{ dir: 親ディレクトリ, file: absolutePath }`

`defaultCommand: "open"` により `orkis <path>` は `orkis open <path>` と同等。

desktop 側はソケット接続チェックで単一インスタンスに制限し、2回目以降の起動は新しいウィンドウとして開く。同じ `dir` で既にウィンドウが開かれている場合は新規作成せずフォーカスする。

### CLI からのアプリ起動（`bin/orkis`）

`bin/orkis` はアプリの起動と CLI コマンドの実行を統合するエントリーポイント。VS Code の `code` コマンドに相当する。

```
bin/orkis <path>
  ├── ソケット接続可 → CLI でメッセージ送信（既存アプリに接続）
  └── ソケット接続不可
       ├── hook コマンド / フラグ → CLI のみ実行（アプリ起動不要）
       └── それ以外
            ├── build なし → pnpm build を実行
            └── Electrobun 起動（ORKIS_PROJECT_ROOT=$PWD）
                 → ソケット待機 → CLI でメッセージ送信
```

### 状態検知（Claude Code Hooks）

`~/.claude/settings.json` にフック設定を記述し、`orkis hook` コマンド経由でアプリのソケットサーバーに状態を通知する。

| エージェントの状態   | フックイベント                                |
| -------------------- | --------------------------------------------- |
| 作業開始             | `UserPromptSubmit`                            |
| 作業中               | `PreToolUse` / `PostToolUse`                  |
| 応答完了（入力待ち） | `Stop`                                        |
| パーミッション待ち   | `Notification` (matcher: `permission_prompt`) |

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [{ "type": "command", "command": "orkis hook running", "async": true }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "orkis hook done", "async": true }]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [{ "type": "command", "command": "orkis hook needs-input", "async": true }]
      }
    ]
  }
}
```

`Stop` フックの stdin JSON に含まれる `transcript_path` から完了サマリーを生成可能。

### Review エージェント

Review も Claude に任せることができる。

```
Goals + Plan + diff → claude -p → GoalResult[] の JSON
```

## データ保存

```
~/Library/Application Support/orkis/   (or ~/.config/orkis/)
├── todos.json
├── plans/
│   └── {todo-id}/
│       ├── master-plan.md
│       ├── sub-plan-{repo-name}.md
│       └── history/
│           └── {revision-id}.md
├── reviews/
│   └── {todo-id}/
│       └── {review-id}.md
└── settings.json
```

iCloud Drive 上のディレクトリを指定すれば同期可能。

## Electrobun を選択した理由

- Bun ランタイム + WKWebView で軽量
- `Bun.spawn({ terminal })` で PTY をネイティブサポート（node-pty 不要）
- 型安全な RPC（ElectrobunRPCSchema）で bun ↔ webview 間通信が宣言的に書ける
- ターミナル、差分ビュー、ブラウザプレビュー、ファイラ、TODO をすべて Web 技術で統一できる

## 将来の拡張

- ブラウザプレビューペイン（開発サーバーの成果物確認）
- 複数 AI プロバイダー対応（Claude Code 以外のエージェント CLI）
