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
  sessionId: string; // 最後に attach した Claude session の ID。空文字は未起動 / 終了済み
  closedByUser: boolean; // ユーザーが明示的にターミナルを閉じたか
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
- `body` は **identity 源には含めない**。Claude が OSC ターミナルタイトル経由で書く揮発メタデータであり、ユーザー意思の identity ではない
- task 本体は **terminal close / SessionEnd で削除しない**。削除はユーザーが明示的に行う (worktree 削除 cascade or サイドバー task 行の ⋮ メニュー)。これにより gh 由来 / 直接起動由来を問わず resume 起点となる sessionId を失わない
- `sessionId` は SessionEnd でも保持し、次回 `claude --resume` の起点に使う
- `closedByUser` は **状態表示専用フラグ**。`detachSession` (SessionEnd / terminal close) で true に倒し、`attachSession` (SessionStart hook) や `add` (PR/issue picker 再選択) で false に戻す。app close (renderer 強制終了) では `detachSession` 経路を通らないため据え置きとなり、自動的に `resumable` 側に倒れる

## task と session の関係

| 概念               | 寿命の始まり                                                    | 寿命の終わり                            |
| ------------------ | --------------------------------------------------------------- | --------------------------------------- |
| **Task**           | PR/issue picker から生成、Claude 直接起動時の SessionStart hook | worktree 削除、⋮ メニューの Remove task |
| **Claude session** | SessionStart hook                                               | SessionEnd hook (task.sessionId は保持) |

1 worktree に対して `WorktreeEntry.tasks` は `repeated Task`。複数の Task が同居しうる。

### attachSession のロジック (Swift `TaskStore.attachSession`)

SessionStart hook で呼ばれる。以下の優先順位で attach 先を決める。

- 同 sessionId が既に attach 済み → 同一セッションの継続 (`claude --resume <sid>` 復帰) が確定している経路。当該 task の `closedByUser` を false に倒し「生きている」状態に戻す
- 同 `worktreeDir` で `sessionId == ""` の task のうち `createdAt` が最新のものに attach。同時に `closedByUser` を false に戻す
- 該当無 → 新規 task を UUID id で作成し sessionId を入れる (Claude 直接起動経路)

### detachSession のロジック (Swift `TaskStore.detachSession`)

SessionEnd hook / terminal close で呼ばれる。

- task 本体は **削除しない** (ghRef 有無に関わらず)
- `task.sessionId` は保持する (再 resume の起点)
- `closedByUser=true` を立てる。サイドバー上の状態表示が `resumable` → `closed` に切り替わる

### clearDeadSession のロジック (Swift `TaskStore.clearDeadSession`)

resume 失敗検出経路 (`claude --resume <sid>` が transcript 不在等で error 終了) で呼ばれる。`markClosedByUser` で caller の意図を切り替える。

- task 本体は削除せず、`sessionId` を空にする。次のクリックで `--resume` ではなく素の `claude` 起動経路へ流す
- `markClosedByUser=true` (terminal close 由来 / `removeByPty`): `closedByUser=true` も立てる
- `markClosedByUser=false` (session-start fallback 由来 / `applyClaudeSessionHook`): `closedByUser` は据え置く。直後の `attachSession(新 sid)` が candidate ピックで同一 task に転移する

### remove のロジック (Swift `TaskStore.remove`)

⋮ メニューの "Remove task" からのみ呼ばれる。指定 id の task を一つ削除する。worktree 削除 cascade と並ぶ唯一のユーザー操作削除経路。

### dead session の検出経路

proactive な transcript ファイル存在チェックはしない (Claude 側の transcript 仕様への依存を避けるため)。dead session は以下の reactive 経路で検出する。

| 経路                                                      | 検出契機                                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **resume 失敗 + zsh fallback** (`applyClaudeSessionHook`) | spawn 時の期待 sid と異なる sid で SessionStart hook が着弾 (resume 起動失敗後に新 session が立ち上がったケース) |
| **resume 失敗 + 不達** (`removeByPty`)                    | 期待 sid が SessionStart hook 不達のまま pane が閉じられた (fallback も SessionStart に到達しなかった経路を含む) |
| **worktree 削除**                                         | `removeByWorktree` で該当 worktreeDir の全 task を cascade 削除                                                  |
| **⋮ メニューの Remove task**                              | `remove` で指定 id の task を削除 (ユーザーの明示操作)                                                           |

zsh wrapper は resume 起動の exit code を見て次の denylist で fallback の発火を判定する。

- ユーザー操作で claude を終わらせた exit code (正常終了 / SIGINT で Ctrl-C 抜け / SIGTERM) → fallback しない
- それ以外の非 0 → 素の claude を即座にリトライする。範囲には transcript 不在 (resume 起動失敗) の他、claude 自身の runtime error (auth / network / API rate limit 等で会話中に非 0 終了したケース) も含む。後者では新規 session が立ち上がるが、これは「resume できる前提が壊れたら新 session で再開する」仕様として認める

同 PTY で発火する新 SessionStart hook の sid が期待 sid と一致しないことを native 側が検知し、dead 期待 sid を永続化ストア (claude session ストア / task ストア) から掃除した上で新 sid を「sessionID 空 candidate」(同 worktree で createdAt 最新の sessionID 空 task。`clearDeadSession` で sessionID を空に書き戻された元 task もここに含まれる) に attach する。同 worktree に他の sessionID 空 task があれば createdAt 最新の方が拾われる点に注意 (元 task に確実に紐付くわけではない)。pane を閉じて再クリックする操作を挟まずに resume が新セッションへ自動転移する。

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
"Workspace: Open Issue" → issue 選択 → worktree 作成 (branch=YYYYMMDD_HHMMSS) + Task 作成
  (body=issue タイトル、ghRef={kind: ISSUE, number: issue 番号}、sessionId="")
```

PR picker と異なり branch 名は timestamp ベース (通常の新規 worktree と同じ命名)。同じ issue から複数の worktree を独立して並行で作れる。issue は head ref を持たないため worktree との 1:1 紐付けを branch 名に埋め込まない。

### Claude を worktree で直接起動 (PR/issue 経由なし)

```text
worktree visit → ターミナル起動 → ユーザーが `claude` を実行
  → SessionStart hook → attachSession が「sessionId 空の最新 task」を探す
  → 該当無しなら新規 task を作成 (body=""、sessionId=新 sid)
```

このルートで生まれた task は `ghRef` を持たない。terminal close 時の `detachSession` でも削除されず、`closedByUser=true` を立てて滞留する。不要になったらユーザーが ⋮ メニューの "Remove task" で明示削除する。

### autostart で起動した claude を終了したあとの挙動

PR/issue picker や session 未紐付け task クリックで `claude` を autostart した leaf でユーザーが `/exit` すると、claude プロセスは終了して素の zsh プロンプトに戻る。task 側は SessionEnd hook 経由で `detachSession` が走り、`closedByUser=true` + `sessionID` 保持で `closed` 表示に切り替わる。

ターミナル自体は素の zsh として残る (`claude` プロセスのみ終了して shell は kill しない)。サイドバーで再度 task をクリックすると `claude --resume <sessionId>` 経路 (sessionId 保持時) または新規 claude 経路 (`Not started` 降格後) に乗る。

### サイドバークリックの分岐 (`SidebarPane.onSelectTask`)

| task.sessionId | live PTY | 動作                                                                    |
| -------------- | -------- | ----------------------------------------------------------------------- |
| 空文字         | —        | `requestNewClaudeSession`: 新 leaf で素の `claude` を起動               |
| 値あり         | あり     | 該当 leaf を focus                                                      |
| 値あり         | 無し     | `requestResumeSession`: 新 leaf で `claude --resume <sessionId>` を起動 |

### 削除・クリーンアップ

| トリガー                                 | 挙動                                                                                                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| worktree 行 `[⋮]` → "Remove worktree"    | worktree 削除 + 該当 `worktreeDir` の全 Task 削除                                                                                                                                        |
| task 行 `[⋮]` → "Remove task"            | 指定 id の Task のみ削除 (`TaskStore.remove`)                                                                                                                                            |
| ターミナル close (PTY 終了)              | `detachSession`: task 本体と sessionId は保持。`closedByUser=true` を立てて状態表示を `closed` に切り替える                                                                              |
| SessionEnd hook                          | 同上                                                                                                                                                                                     |
| app close (renderer 強制終了)            | `detachSession` 経路を通らないため `closedByUser` 据え置き。次回起動時にサイドバーに `resumable` として表示される                                                                        |
| resume 失敗 + zsh fallback で新 sid 着弾 | `clearDeadSession(markClosedByUser=false)`: dead 期待 sid を claude session ストアから削除し、task の sessionId を空にする。`closedByUser` 据え置き                                      |
| ターミナル close で resume 失敗検出      | `clearDeadSession(markClosedByUser=true)`: 期待 sid が SessionStart hook 不達のまま閉じた場合、dead sid を claude session ストアから削除し、task の sessionId を空 + `closedByUser=true` |
| 外部で worktree 消失                     | `gitWorktreeList` 取得時に存在しない `worktreeDir` を検出し Task 自動削除                                                                                                                |

## サイドバー UI における状態表示

`TaskRow` の state アイコンは以下の 3 区分で「session の現在状態」と「ユーザーの意思」を表現する。

| 状態          | 判定条件                                                | アイコン                | 意味                                                                 |
| ------------- | ------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------- |
| `not-started` | `sessionId == ""`                                       | `lucide--circle-dashed` | Claude が一度も起動していない (picker 直後 / resume 失敗で sid 空化) |
| `resumable`   | `sessionId != ""` + `closedByUser == false` + live なし | `lucide--square-play`   | app close で中断された (ユーザーは閉じていない)                      |
| `closed`      | `sessionId != ""` + `closedByUser == true` + live なし  | `lucide--eye-closed`    | ユーザーが明示的にターミナルを閉じた                                 |

`resumable` と `closed` のクリック挙動は同じ (`claude --resume <sessionId>`)。UI 上の意味的区別だけを行う。live PTY ありの状態 (idle / working / asking / done) は `CLAUDE_STATE_ICON` 由来のアイコンが優先される。

## RPC

```text
taskAdd:    { dir, body, worktreeDir, ghRef? } → Task
taskUpdate: { dir, id, body } → Task            (OSC title 同期で使用)
taskRemove: { dir, id } → {}                    (⋮ メニューの明示削除)
```

`taskAdd` は **upsert** 動作。`ghRef` 指定があり同 `worktreeDir` + 同 `ghRef` の既存 task が見つかれば、その `body` を上書き + `closedByUser=false` で再活性化して返す (`id` / `createdAt` / `sessionId` は保持)。それ以外は新規 task を UUID で作成する。PR picker は新規作成ルートと `pr.headRef` による既存 worktree hit ルートの両方で同じ `taskAdd` を呼び、再選択で closed 化済み task を蘇らせる。issue picker は branch を timestamp ベースにしているため常に新規作成ルートに倒れる。

## サイドバー UI レイアウト

```text
ROOT
  🏠 main

WORKTREES
  ● feature-aの実装    [⋮]
  ● #123 Fix bug       [⋮]   ← ghRef が設定済みなら `#番号` プレフィックス
  ● (無題)              [⋮]
```

セッションが attach 中の task には Claude ステータスのバッジ / 吹き出しが付く。session 未紐付け task (`sessionId == ""`) は静的表示。task 行も hover で右端に `[⋮]` ボタンが現れ、`Remove task` が選択できる。
