# Task 管理

worktree に紐づく作業項目を管理する。Task は PR/issue/手動操作で生まれる永続オブジェクトで、Claude session は task に attach する短命属性として扱う。サイドバーで Task をクリックすると attach 中の session があれば `claude --resume`、無ければ素の `claude` が起動して SessionStart hook で attach される。

## データモデル

```typescript
interface Task {
  id: string; // UUID (Swift 側 TaskStore.add で生成)
  body: string; // git commit 形式: 一行目=タイトル、残り=本文
  worktreeDir: string; // 紐づいた worktree のパス
  ghRef?: GhRef; // GitHub PR/issue 参照。両方同時設定は型で排他 (number 単一)
  createdAt: string; // ISO 8601
  sessionId: string; // 最後に attach した Claude session の ID。空文字は未起動 / SessionEnd 済み
}
interface GhRef {
  kind: GhRefKind; // GH_REF_KIND_PR | GH_REF_KIND_ISSUE
  number: number;
}
```

GitHub では PR と issue が同一の番号空間を共有するため、種別 + 番号の組で表現する。`ghRef` 自体の有無で「PR/issue 由来 task かどうか」を判定する。

- `id` は Claude session id と独立した UUID。session の生成 / 消滅で task は再作成されない
- `body` は git commit メッセージと同じ構造。一行目をタイトルとして表示に使う
- `body` が空かつ `ghRef` 未設定のとき表示は「(無題)」相当
- `sessionId` は SessionEnd でも保持し、次回 `claude --resume` の起点に使う

## task と session の関係

| 概念               | 寿命の始まり                                                    | 寿命の終わり                            |
| ------------------ | --------------------------------------------------------------- | --------------------------------------- |
| **Task**           | PR/issue picker から生成、Claude 直接起動時の SessionStart hook | worktree 削除、自動 cleanup             |
| **Claude session** | SessionStart hook                                               | SessionEnd hook (task.sessionId は保持) |

1 worktree に対して `WorktreeEntry.tasks` は `repeated Task`。複数の Task が同居しうる。

### attachSession のロジック (Swift `TaskStore.attachSession`)

SessionStart hook で呼ばれる。以下の優先順位で attach 先を決める。

- 同 sessionId が既に attach 済み → no-op (重複 hook / 復元レース)
- 同 `worktreeDir` で `sessionId == ""` の task のうち `createdAt` が最新のもの → attach
- 該当無し → 新規 task を UUID id で作成し sessionId を入れる (Claude 直接起動経路)

### detachSession のロジック (Swift `TaskStore.detachSession`)

SessionEnd hook / terminal close で呼ばれる。

- task.sessionId は保持する (再 resume の起点)
- `body == ""` かつ `ghRef` 未設定の task のみ削除する (Claude 直接起動 + 即終了の残骸掃除)

### reconcile (`TaskStore.reconcileAll`)

起動時に `claude-sessions.json` の生存 sessionId 集合と突き合わせる。

- dead sessionId は task からクリアする (task 本体は維持)
- `body / ghRef / sessionId` すべて空の task のみ削除する (AND 条件)

## 保存

`~/.config/gozd/projects/<projectKey>/tasks.json` に proto3 JSON で `TaskList` を保存する。`projectKey` は dir の realpath から SHA-256 で算出する (Claude Code と同じ方式に依存しない)。

## ライフサイクル

### PR から worktree 作成

```text
"Workspace: Open Pull Request" → PR 選択 → worktree 作成 + Task 作成
  (body=PR タイトル、ghRef={kind: PR, number: PR 番号}、sessionId="")
```

サイドバーで該当行をクリックすると素の `claude` が起動し、SessionStart hook で attach される。

### Issue から worktree 作成

```text
"Workspace: Open Issue" → issue 選択 → worktree 作成 (branch=issue-<N>) + Task 作成
  (body=issue タイトル、ghRef={kind: ISSUE, number: issue 番号}、sessionId="")
```

### Claude を worktree で直接起動 (PR/issue 経由なし)

```text
worktree visit → ターミナル起動 → ユーザーが `claude` を実行
  → SessionStart hook → attachSession が「sessionId 空の最新 task」を探す
  → 該当無しなら新規 task を作成 (body=""、sessionId=新 sid)
```

OSC title が反映されて body が埋まった task は SessionEnd 後も `sessionId` を保持して永続化される (`detachSession` の孤児判定 `body / ghRef / sessionId` AND で身元残存のため削除されない)。サイドバーでは `Resumable` 状態で残り、再クリックすると `claude --resume` 経路で同じ task に再 attach される。Claude を完全に捨てたい場合は次のアプリ起動時 reconcile を経て `transcript` が dead 判定されると `sessionId` がクリアされ、body は残ったまま `Not started` に降格する。

### autostart で起動した claude を終了したあとの挙動

PR/issue picker や session 未紐付け task クリックで `claude` を autostart した leaf でユーザーが `/exit` すると、claude プロセスは終了して素の zsh プロンプトに戻る。task 側は SessionEnd hook 経由で `detachSession` が走り、`sessionId` を切り離す (body が埋まっていれば task は残り `Resumable` 表示、body / ghRef / sessionId すべて空なら task ごと削除)。

ターミナル自体は素の zsh として残る (`claude` プロセスのみ終了して shell は kill しない)。サイドバーで再度 task をクリックすると `claude --resume <sessionId>` 経路 (sessionId 保持時) または新規 claude 経路 (`Not started` 降格後) に乗る。

### サイドバークリックの分岐 (`SidebarPane.onSelectTask`)

| task.sessionId | live PTY | 動作                                                                    |
| -------------- | -------- | ----------------------------------------------------------------------- |
| 空文字         | —        | `requestNewClaudeSession`: 新 leaf で素の `claude` を起動               |
| 値あり         | あり     | 該当 leaf を focus                                                      |
| 値あり         | 無し     | `requestResumeSession`: 新 leaf で `claude --resume <sessionId>` を起動 |

### 削除・クリーンアップ

| トリガー                              | 挙動                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------- |
| worktree 行 `[⋮]` → "Remove worktree" | worktree 削除 + 該当 `worktreeDir` の全 Task 削除                         |
| ターミナル close (PTY 終了)           | `detachSession`: sessionId 切り離し。body/ghRef が空なら task 削除        |
| SessionEnd hook                       | `detachSession`: 同上                                                     |
| 外部で worktree 消失                  | `gitWorktreeList` 取得時に存在しない `worktreeDir` を検出し Task 自動削除 |
| 起動時 reconcile                      | dead sessionId クリア + identity が完全に消えた task のみ削除             |

## RPC

```text
taskAdd:    { dir, body, worktreeDir, ghRef? } → Task
taskUpdate: { dir, id, body } → Task            (OSC title 同期で使用)
```

`taskAdd` の id は server 側で生成して返す。

## サイドバー UI

```text
ROOT
  🏠 main

WORKTREES
  ● feature-aの実装    [⋮]
  ● #123 Fix bug       [⋮]   ← ghRef が設定済みなら `#番号` プレフィックス
  ● (無題)              [⋮]
```

セッションが attach 中の task には Claude ステータスのバッジ / 吹き出しが付く。session 未紐付け task (`sessionId == ""`) は静的表示。
