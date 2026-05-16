# Task 管理

worktree に紐づく作業項目を管理する。Task は PR/issue/手動操作で生まれる永続オブジェクトで、Claude session は task に attach する短命属性として扱う。サイドバーで Task をクリックすると attach 中の session があれば `claude --resume`、無ければ素の `claude` が起動して SessionStart hook で attach される。

## データモデル

```typescript
interface Task {
  id: string; // UUID (Swift 側 TaskStore.add で生成)
  body: string; // git commit 形式: 一行目=タイトル、残り=本文
  worktreeDir: string; // 紐づいた worktree のパス
  ghRef?: GhRef; // GitHub PR/issue 参照。task 1 件あたり最大 1 つ
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
- `body` は **identity 源には含めない**。Claude が OSC ターミナルタイトル経由で書く揮発メタデータであり、ユーザー意思の identity ではない。terminal を閉じた時点で body しか持たない task (root wt 上で直接 claude を起動したケース等) は削除する
- `ghRef` のみが **identity 源**。PR/issue picker でユーザーが明示的に紐づけた永続情報なので、terminal close を越えて保持し、worktree 削除で cascade 回収する
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
- `ghRef` 未設定の task のみ削除する (Claude 直接起動 + 即終了の残骸掃除。body は identity に含めない)

### clearDeadSession のロジック (Swift `TaskStore.clearDeadSession`)

resume 失敗検出経路 (`claude --resume <sid>` が transcript 不在等で error 終了) で呼ばれる。

- `ghRef` ありなら sessionId を空に書き換え、task 本体は残す (次クリックで素の claude 起動に流す)
- `ghRef` なしなら task ごと削除する
- `detachSession` との違い: identity ありでも sessionId を確定 dead として書き換える

### dead session の検出経路

proactive な transcript ファイル存在チェックはしない (Claude 側の transcript 仕様への依存を避けるため)。dead session は以下の reactive 経路で検出する。

| 経路                                                      | 検出契機                                                                                                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **resume 失敗 + zsh fallback** (`applyClaudeSessionHook`) | spawn 時 `GOZD_RESUME_CLAUDE_SESSION` 期待 sid と異なる sid で SessionStart hook が着弾 (`claude --resume X` 失敗後に zsh が素 `claude` を起動して新 sid を発行したケース) |
| **resume 失敗 + 不達** (`removeByPty`)                    | 期待 sid が SessionStart hook 不達のまま pane が閉じられた (zsh fallback も SessionStart に到達しなかった / ユーザーが素シェルのまま閉じた)                                |
| **worktree 削除**                                         | `removeByWorktree` で該当 worktreeDir の全 task を cascade 削除                                                                                                            |
| **ターミナル close (identity 無)**                        | `detachSession` で `ghRef` なし task を削除 (root wt の身元なし残骸)                                                                                                       |

zsh wrapper (`apps/native/Resources/zsh/.zshrc`) は `claude --resume "$_id" || claude` で resume 失敗時に素 `claude` を即座にリトライする。同 PTY で発火する新 SessionStart hook の sid が `GOZD_RESUME_CLAUDE_SESSION` と一致しないことを native 側が検知し、dead 期待 sid を `claude-sessions.json` / `tasks.json` から掃除した上で新 sid を「sessionID 空 candidate」となった元 task に attach する。pane を閉じて再クリックする操作を挟まずに resume が新セッションへ自動転移する。

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

root wt 上で直接 `claude` を起動した task (PR/issue picker を経由しないケース) は `ghRef` を持たないため、terminal close 時の `detachSession` でそのまま削除される。これにより root wt は `git worktree remove` されない一方で task が累積する leak を構造的に塞いでいる。専用 worktree 上で直接 `claude` を起動した task も同様に terminal close で揮発するが、こちらは worktree 自体が短命なので不利益は小さい。

### autostart で起動した claude を終了したあとの挙動

PR/issue picker や session 未紐付け task クリックで `claude` を autostart した leaf でユーザーが `/exit` すると、claude プロセスは終了して素の zsh プロンプトに戻る。task 側は SessionEnd hook 経由で `detachSession` が走り、`ghRef` があれば task と `sessionID` を保持 (`Resumable` 表示)、無ければ task ごと削除する。

ターミナル自体は素の zsh として残る (`claude` プロセスのみ終了して shell は kill しない)。サイドバーで再度 task をクリックすると `claude --resume <sessionId>` 経路 (sessionId 保持時) または新規 claude 経路 (`Not started` 降格後) に乗る。

### サイドバークリックの分岐 (`SidebarPane.onSelectTask`)

| task.sessionId | live PTY | 動作                                                                    |
| -------------- | -------- | ----------------------------------------------------------------------- |
| 空文字         | —        | `requestNewClaudeSession`: 新 leaf で素の `claude` を起動               |
| 値あり         | あり     | 該当 leaf を focus                                                      |
| 値あり         | 無し     | `requestResumeSession`: 新 leaf で `claude --resume <sessionId>` を起動 |

### 削除・クリーンアップ

| トリガー                                 | 挙動                                                                                                                                                                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| worktree 行 `[⋮]` → "Remove worktree"    | worktree 削除 + 該当 `worktreeDir` の全 Task 削除                                                                                                                                                                                                          |
| ターミナル close (PTY 終了)              | `detachSession`: sessionId 切り離し。`ghRef` 無しなら task 削除                                                                                                                                                                                            |
| SessionEnd hook                          | `detachSession`: 同上                                                                                                                                                                                                                                      |
| resume 失敗 + zsh fallback で新 sid 着弾 | `clearDeadSession`: spawn 時 `GOZD_RESUME_CLAUDE_SESSION` 期待 sid と異なる sid で SessionStart hook が届いた場合、dead 期待 sid を `claude-sessions.json` から削除し、task の sessionId を空に書き換え (ghRef 無しなら task 削除)、続けて新 sid を attach |
| ターミナル close で resume 失敗検出      | `clearDeadSession`: 期待 sid が SessionStart hook 不達のまま閉じた場合 (zsh fallback も SessionStart に到達しなかった)、dead sid を `claude-sessions.json` から削除し、task の sessionId を空に書き換える (ghRef 無しなら task 削除)                       |
| 外部で worktree 消失                     | `gitWorktreeList` 取得時に存在しない `worktreeDir` を検出し Task 自動削除                                                                                                                                                                                  |

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
