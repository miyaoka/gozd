# Task 管理

worktree に紐づく作業項目を管理する。Task は PR/issue/手動操作で生まれる永続オブジェクトで、Claude session は task に attach する短命属性として扱う。サイドバーで Task をクリックすると attach 中の session があれば `claude --resume`、無ければ素の `claude` が起動して SessionStart hook で attach される。

## データモデル

```typescript
interface Task {
  id: string; // UUID (Swift 側 TaskStore.add で生成)
  userTitle: string; // ユーザーが UI で明示編集した確定タイトル
  ghTitle: string; // PR/issue picker 取得時の snapshot タイトル
  terminalTitle: string; // OSC ターミナルタイトル経由で観測した live 値
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
- task 本体は **terminal close / SessionEnd で削除しない**。削除はユーザーが明示的に行う (worktree 削除 cascade or サイドバー task 行の ⋮ メニュー)。これにより gh 由来 / 直接起動由来を問わず resume 起点となる sessionId を失わない
- `sessionId` は SessionEnd でも保持し、次回 `claude --resume` の起点に使う
- `closedByUser` は **状態表示専用フラグ**。`detachSession` (SessionEnd / terminal close) で true に倒し、`attachSession` (SessionStart hook) や `add` (PR/issue picker 再選択) で false に戻す。app close (renderer 強制終了) では `detachSession` 経路を通らないため据え置きとなり、自動的に `resumable` 側に倒れる

### タイトル 3 レイヤ (起源で分離)

タイトルは起源で 3 フィールドに分離し、それぞれ独立した寿命を持つ。書き込み経路を交差させない契約で「gh 由来 task が terminal 観測値で上書きされる」事故を構造的に排除する。

| field           | 性質                          | 書き込み経路                           |
| --------------- | ----------------------------- | -------------------------------------- |
| `userTitle`     | ユーザー編集の確定値 (最優先) | 編集 dialog Save                       |
| `ghTitle`       | gh picker snapshot (静的)     | PR/issue picker 作成時 + revive upsert |
| `terminalTitle` | OSC 観測値 (動的)             | OSC タイトル更新時                     |

#### 表示優先度 (`resolveDisplayTitle` SSOT)

```text
userTitle 非空 → userTitle
ELSE ghTitle 非空 → ghTitle
ELSE terminalTitle 非空 (CLAUDE_PLACEHOLDER "Claude Code" 除外) → terminalTitle
ELSE undefined (呼び出し側で "New session" or "#N" にフォールバック)
```

`ghRef` ありの task は先頭に PR/issue 番号が付く。

#### 編集 dialog (`TaskEditDialog`)

`userTitle` を編集する `input` 1 つに操作を集約する。

- input placeholder に `placeholderForEmptyUserTitle(task)` (= `taskDisplayTitle({ ...task, userTitle: "" })` の SSOT 再利用) を動的バインドし、`#N` prefix や "New session" フォールバックを含めてサイドバー表示と一致する形で「Save 時の見え方」を予告する
- Sources セクションは `ghTitle` / `terminalTitle` を参考表示するだけ (操作なし、選択可能テキストでコピペ可)
- 空文字保存 = `userTitle` クリア = フォールバックチェーンに復帰 (専用 reset ボタンを置かない)

## task と session の関係

| 概念               | 寿命の始まり                                                    | 寿命の終わり                            |
| ------------------ | --------------------------------------------------------------- | --------------------------------------- |
| **Task**           | PR/issue picker から生成、Claude 直接起動時の SessionStart hook | worktree 削除、⋮ メニューの Remove task |
| **Claude session** | SessionStart hook                                               | SessionEnd hook (task.sessionId は保持) |

1 worktree に対して `WorktreeEntry.tasks` は `repeated Task`。複数の Task が同居しうる。

### attachSession のロジック (Swift `TaskStore.attachSession`)

SessionStart hook で呼ばれる。以下の優先順位で attach 先を決める。

- 同 sessionId が既に attach 済み → 同一セッションの継続 (`claude --resume <sid>` 復帰) が確定している経路。当該 task の `closedByUser` を false に倒し「生きている」状態に戻す
- 同 `worktreeDir` の `sessionId == ""` candidate から pick (createdAt 最大値、tie-break は id 辞書順で最大値) し、新 sid を attach。`closedByUser=true` でも `sessionId` が空なら candidate に含め、pick 時に false へ戻す (resume 失敗で sid を空に戻された task 等)。**`closedByUser=true` でも `sessionId` を保持する (= resume 可能な) task は candidate にしない**。新しい session_id は必ず別 task になる (session ≒ task の 1:1。`/clear` で session_id が変わったら別 task。既存 task の sid を別 session が奪う hijack はしない)。累積した closed task はユーザーが ⋮ メニュー or worktree 削除 cascade で消す
- 該当無 → 新規 task を UUID id で作成し sessionId を入れる (Claude 直接起動経路)

> [!NOTE]
> **不変条件**: `sessionId` は Claude が session ごとに振る UUID で worktree 内で一意。`attachSession` priority 1 / `detachSession` / `clearDeadSession` はいずれも `firstIndex(sessionID ==)` で 1 件のみに作用するが、closed task が累積しても各 task は異なる `sessionId` を持つため引き当ては曖昧にならない。新規 sid は priority 1 で既存と衝突せず (一致すれば継続扱いの no-op)、priority 2 / 新規作成でも live session の一意な sid が入るので、同一 `sessionId` を持つ task が 2 つ並ぶことはない。

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

### ライフサイクル遷移 (SSOT)

dead session 検出 / 削除 / 状態フラグの作用は経路ごとに以下の 1 表に集約する。`detachSession` / `clearDeadSession` / `remove` / `removeByWorktree` / app close の各経路で `task 本体` / `sessionID` / `closedByUser` がどう動くかをここで確定させる。

| 経路                                               | 関数                                 | task 本体 | sessionID | closedByUser     |
| -------------------------------------------------- | ------------------------------------ | --------- | --------- | ---------------- |
| ターミナル close (live session)                    | `detachSession`                      | 保持      | 保持      | true             |
| SessionEnd hook                                    | `detachSession`                      | 保持      | 保持      | true             |
| ターミナル close (resume 失敗 + SessionStart 不達) | `clearDeadSession(markClosed=true)`  | 保持      | 空        | true             |
| resume 失敗 + zsh fallback (新 sid 着弾)           | `clearDeadSession(markClosed=false)` | 保持      | 空        | 据え置き         |
| app close (renderer 強制終了 / クラッシュ)         | —                                    | 保持      | 保持      | 据え置き (false) |
| worktree 行 `[⋮]` → "Remove worktree"              | `removeByWorktree`                   | 削除      | —         | —                |
| task 行 `[⋮]` → "Remove task"                      | `remove`                             | 削除      | —         | —                |
| 外部で worktree 消失 (`gitWorktreeList` で検知)    | `removeByWorktree`                   | 削除      | —         | —                |

#### 失敗時の注意

`detachSession` / `clearDeadSession` の I/O (JSON write) が throw した場合、stderr ログのみ残り `closedByUser` は据え置きになる。結果として「ユーザーが閉じたのに `resumable` 表示」になる lying state が出る。ログ (`[TaskStore] detachSession failed: ...`) と onNotify トーストで観察可能化しているが、UI 上の `closed` / `resumable` 区別は **detachSession 成功を前提とした best-effort な semantic** である点に留意する。修正は I/O 失敗の根本原因 (権限 / disk / corruption) を直す。

### dead session 自動検出の補足

proactive な transcript ファイル存在チェックはしない (Claude 側の transcript 仕様への依存を避けるため)。zsh wrapper は resume 起動の exit code を見て次の denylist で fallback の発火を判定する。

- ユーザー操作で claude を終わらせた exit code (正常終了 / SIGINT で Ctrl-C 抜け / SIGTERM) → fallback しない
- それ以外の非 0 → 素の claude を即座にリトライする。範囲には transcript 不在 (resume 起動失敗) の他、claude 自身の runtime error (auth / network / API rate limit 等で会話中に非 0 終了したケース) も含む。後者では新規 session が立ち上がるが、これは「resume できる前提が壊れたら新 session で再開する」仕様として認める

同 PTY で発火する新 SessionStart hook の sid が期待 sid と一致しないことを native 側が検知し、dead 期待 sid を永続化ストア (claude session ストア / task ストア) から掃除した上で新 sid を attachSession の candidate (上記 priority 2 の「sessionId 空」) に attach する。`clearDeadSession` (`markClosedByUser=false`) が元 task の sessionID を空に書き戻すことで、その元 task が sessionId 空 candidate として pick 対象に乗る。pick ルールは createdAt 最大値、tie-break は id 辞書順で最大値 (= 1 秒以内に複数 task が並ぶ稀ケースで決定論的に倒すため)。同 worktree に他の sessionId 空 candidate があれば createdAt 最新の方が拾われる点に注意 (元 task に確実に紐付くわけではない)。pane を閉じて再クリックする操作を挟まずに resume が新セッションへ自動転移する。

## 保存

`~/.config/gozd/projects/<projectKey>/tasks.json` に proto3 JSON で `TaskList` を保存する。`projectKey` は dir の realpath から SHA-256 で算出する (Claude Code と同じ方式に依存しない)。

## ライフサイクル

### PR から worktree 作成

```text
"Workspace: Open Pull Request" → PR 選択 → worktree 作成 + Task 作成
  (ghTitle=PR タイトル、userTitle=""、ghRef={kind: PR, number}、sessionId="")
```

サイドバーで該当行をクリックすると素の `claude` が起動し、SessionStart hook で attach される。

### Issue から worktree 作成

```text
"Workspace: Open Issue" → issue 選択 → worktree 作成 (branch=YYYYMMDD_HHMMSS) + Task 作成
  (ghTitle=issue タイトル、userTitle=""、ghRef={kind: ISSUE, number}、sessionId="")
```

PR picker と異なり branch 名は timestamp ベース (通常の新規 worktree と同じ命名)。同じ issue から複数の worktree を独立して並行で作れる。issue は head ref を持たないため worktree との 1:1 紐付けを branch 名に埋め込まない。

### Claude を worktree で直接起動 (PR/issue 経由なし)

```text
worktree visit → ターミナル起動 → ユーザーが `claude` を実行
  → SessionStart hook → attachSession が「sessionId 空の最新 task」を探す
  → 該当無しなら新規 task を作成 (全 title 空、sessionId=新 sid)
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

## サイドバー UI における状態表示

`TaskRow` の state アイコンは以下の 3 区分で「session の現在状態」と「ユーザーの意思」を表現する。

| 状態          | 判定条件                                                | アイコン                | 意味                                                                 |
| ------------- | ------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------- |
| `not-started` | `sessionId == ""`                                       | `lucide--circle-dashed` | Claude が一度も起動していない (picker 直後 / resume 失敗で sid 空化) |
| `resumable`   | `sessionId != ""` + `closedByUser == false` + live なし | `lucide--square-play`   | app close で中断された (ユーザーは閉じていない)                      |
| `closed`      | `sessionId != ""` + `closedByUser == true` + live なし  | `lucide--eye-closed`    | ユーザーが明示的にターミナルを閉じた                                 |

`resumable` と `closed` のクリック挙動は同じ (`claude --resume <sessionId>`)。UI 上の意味的区別だけを行う。live PTY ありの状態 (idle / working / asking / done) は `CLAUDE_STATE_ICON` 由来のアイコンが優先される。

> [!IMPORTANT]
> resumable / closed task の click は `task.sessionId` (tasks.json) を resume 対象の SSOT とする。未訪問 worktree の click は `useTerminalStore` の `visit` 経路を通るが、ここで `claude-sessions.json` (session-end hook で削除される別ライフサイクルのストア) に当該 sessionId が無くても resume は実行する。`claude-sessions.json` は「複数 leaf の自動復元」用の補助リストであり、明示 click の可否判定には使わない。saved リストで gate すると closed session (= `claude-sessions.json` から消えているが tasks.json には残る通常状態) の初回 click が空ターミナルに倒れる。

resume 可否の検証は renderer では行わず、native 側の dead session 清掃 (hook 経路) に一元化する。transcript が消えた dead な sessionId を resume しようとした場合の挙動は決定的に次へ倒れる:

- `claude --resume <dead-sid>` が失敗 → zsh fallback で素の `claude` が起動し SessionStart hook が着弾
- native が `consumeExpectedResumeSid` で「期待した resume sid ≠ 実際の新 sid」を検知し `clearDeadSession` で task の sessionId を空化 → サイドバー表示が `not-started` に倒れる
- この経路で renderer のトーストは出ない。観察可能性は native の stderr ログと task の状態遷移 (`closed` → `not-started`) が担う

つまり dead session の click は「resume 失敗を UI で通知する」のではなく「素の claude 起動にサイレントにフォールバックし、task を `not-started` に戻す」のが期待挙動。resume 可否を click 時点で事前判定する責務は renderer に置かない。

## RPC

```text
taskAdd:               { dir, userTitle, ghTitle, worktreeDir, ghRef? } → Task
taskSetTerminalTitle:  { dir, id, terminalTitle } → Task   (OSC title 同期で使用)
taskSetUserTitle:      { dir, id, userTitle } → Task       (編集 dialog Save、空文字も valid = reset)
taskRemove:            { dir, id } → {}                    (⋮ メニューの明示削除)
```

`taskAdd` は **upsert** 動作。`ghRef` 指定があり同 `worktreeDir` + 同 `ghRef` の既存 task が見つかれば、その `ghTitle` を上書き + `closedByUser=false` で再活性化して返す (`id` / `createdAt` / `sessionId` / `userTitle` / `terminalTitle` は保持。**ユーザー編集レイヤである `userTitle` は触らない**)。それ以外は新規 task を UUID で作成する。PR picker は新規作成ルートと `pr.headRef` による既存 worktree hit ルートの両方で同じ `taskAdd` を呼び、再選択で closed 化済み task を蘇らせる + `ghTitle` を最新化する。issue picker は branch を timestamp ベースにしているため常に新規作成ルートに倒れる。

`taskSetUserTitle` は空文字も valid な確定値として受理する (reset 操作経路を別動詞で増やさず、編集 dialog の `input` 操作に集約する)。

## サイドバー UI レイアウト

```text
ROOT
  🏠 main

WORKTREES
  ● feature-aの実装    [⋮]
  ● #123 Fix bug       [⋮]   ← ghRef が設定済みなら `#番号` プレフィックス
  ● New session         [⋮]   ← 全 title 空 + ghRef 無しのフォールバック
```

セッションが attach 中の task には Claude ステータスのバッジ / 吹き出しが付く。session 未紐付け task (`sessionId == ""`) は静的表示。task 行も hover で右端に `[⋮]` ボタンが現れ、`Edit title` / `Show session log` / `Remove task` が選択できる。task 行のダブルクリックでも編集 dialog が開く。

### セッションログ表示 (`Show session log`)

`task.sessionId` が非空のときだけ ⋮ メニューに出る。選択すると `SessionLogDialog` が開き、Claude Code が `~/.claude/projects/<cwd エンコード>/<sessionId>.jsonl` に書き出したセッションログを整形トランスクリプトとして表示する。

- **ファイル解決は glob**: cwd → ディレクトリ名のエンコード規則は Claude 側の内部仕様で将来変わりうるため再構成に依存せず、native (`ClaudeSessionLog.read`) が `~/.claude/projects/*/<sessionId>.jsonl` を glob 解決する。`sessionId` は `[0-9a-fA-F-]` のみ許可で検証し path traversal を塞ぐ。RPC は `/claudeSession/readLog` (生 JSONL を返し、parse は renderer 側 `parseSessionLog`)
- **表示対象**: user / assistant / thinking / tool / image の会話イベント。`tool_use` と `tool_result` は `tool_use_id` でペア化して 1 ブロックにまとめる。system 等の非会話レコードと `queued_command` 以外の attachment は載せず件数だけ footer に集計する。平文の無い thinking (最新モデルの暗号化 signature のみ / フィールド欠落) も載せないが、会話イベントなので非会話レコードとは別カウンタ (`emptyThinking`) にし、footer で別ラベル表示する。image は base64 source を data URL にして `<img>` 描画する
- **注入 user レコードの除外と slash command / queued_command の表示**: harness は `<local-command-stdout>` / `<task-notification>` / `<system-reminder>` 等を `type:"user"` + content=string (isMeta:null) で main loop に注入する。これらはユーザーの生発話ではないため、先頭ラッパータグで判定して USER ブロック / 目次に出さず skipped に計上する。`isMeta:true` の user レコードも同様に除外する。一方、先頭が `<command-name>` / `<command-message>` で始まる slash command 起動 (`/foo`) はユーザーの操作なので `slashCommandText` がコマンド名 (引数があれば `/foo args`) を取り出して載せる。採否を先頭アンカー (`COMMAND_BLOCK_LEAD_RE`) で決めることで、本文中にたまたま `<command-name>` を含む生発話を slash command と誤認して切り詰めない。さらにエージェント作業中に積まれた **queued command** は本文が `type:"user"` に昇格せず `type:"attachment"` の `attachment.type:"queued_command"` (`attachment.prompt`) にしか残らないことがあるため、これも載せる。採否は上流 (Claude Code) が分類済みの `attachment.commandMode` を SSOT にし、生発話 (`"prompt"`) のみ拾う。注入通知 (`"task-notification"` 等) は除外する。本文パターンで種別を再導出しないため、`<span>` 始まり等の正当な生発話を取りこぼさない
- **サブエージェントのログも表示**: Task ツールで起動したサブエージェントの会話は `~/.claude/projects/<encoded>/<親sessionId>/subagents/agent-<agentId>.jsonl` に別ファイル (`isSidechain:true`) + 同名 `.meta.json` (`agentType` / `description` / `toolUseId`) で記録される。native (`ClaudeSessionLog.read`) は main を解決した projectDir からこのサブディレクトリを列挙し、main + subagents を entry 配列で返す。各 transcript ペインは `SessionLogTranscript` (目次 + チャット + scroll-spy をインスタンス内に閉じる) が描画する
- **Workflow サブエージェントのログも表示**: Workflow ツール (`agent()` 呼び出し) で起動したサブエージェントは 1 階層深い `~/.claude/projects/<encoded>/<親sessionId>/subagents/workflows/<wf_id>/agent-<agentId>.jsonl` に記録される。これらの `.meta.json` は `agentType` しか持たないため、表示名 (`label`) / phase (`phaseTitle`) / workflow 名は兄弟ディレクトリ `<親sessionId>/workflows/<wf_id>.json` の `workflowProgress` から `agentId` をキーに JOIN する (`agentType` は `null` のことがあり、その場合のみ agent の `.meta.json` をフォールバック)。native はこれらも列挙し、entry に `workflow_run_id` / `workflow_name` / `phase_title` を載せて返す
- **Main + subagent の 2 ペイン同時表示**: dialog は Main を左ペインに常時表示し、subagent があればヘッダ下の subagent タブで選んだ 1 つを右ペインに横並びで出す。subagent が無ければ Main を全幅表示しタブも出さない。タブバーは Task ツール subagent (`workflow_run_id` 空) をフラットなチップ列、Workflow agent を `workflow_run_id` ごとにグループ化して workflow 名見出し付きで並べる (各チップは `phaseTitle · label`)。scroll-spy (`IntersectionObserver`) はペインごとに独立する
- **subagent へのジャンプボタン + 時刻同期**: Main の `Agent` (新規 spawn) / `SendMessage` (resume) / `Workflow` (workflow 起動) tool 行に、紐づく subagent を右ペインで開く黄色いボタン (`SessionLogSubagentButton`) を出す。紐付けキーは 3 系統で、`Agent` は main の `tool_use.id` == subagent meta.json の `toolUseId` (proto `parent_tool_use_id` で露出)、`SendMessage` は main の `tool_use.input.to` == subagent の `agent_id` または `name` (Claude Code は `to` に id / name のどちらも取りうるため両引きし、id を優先。proto `name` で露出。同名 subagent が複数ある name は一意に決められずリンクを張らない)、`Workflow` は main の tool_result テキストの `Run ID: wf_xxx` == workflow agent の `workflow_run_id` (1 Workflow = N agent なので先頭 agent に結び、残りはタブバーのグループから辿る。ラベルは `<workflow 名> (件数)`)。ボタンクリックで右ペインをその subagent に切り替え、呼び出し時刻に最も近い subagent イベントへスクロール同期する (resume の注入 user メッセージは SendMessage 発火の数十ms後に subagent ログへ書かれるため最近傍 ts で当たる)
- **assistant は markdown 描画**: preview feature から切り出した `MarkdownBody` (marked + DOMPurify) で描画する。user / thinking は素テキスト
- **左に目次**: user / assistant のみを時刻見出しで並べ、クリックで該当イベントへスクロール。`IntersectionObserver` で現在地をハイライトする (純 CSS の scroll marker / `:target-current` は WebKit 未対応のため)。各イベント見出しは `position: sticky` で上部固定
- **各 agent の使用 model 表示**: 各 transcript ペインのヘッダ (`SessionLogTranscript`) と横断タイムラインの gutter (`SessionLogTimeline`) に、その agent が実際に使った model を出す。出典は assistant レコードの `message.model` 実測値で `parseSessionLog` が出現順ユニークに集め (`ParsedSessionLog.models`)、`formatModelLabel` が `claude-opus-4-8` → `Opus 4.8` に整形する。jsonl 内に閉じるため main / subagent 問わず採れ、`/model` 切り替えで複数混在した場合は中黒で連ねる。effort は jsonl に書き出されず agent 定義 frontmatter にしか無いため、セッションファイル自己完結の方針として model のみ表示する
- **ライブ更新**: dialog が開いている間、`SessionLogDialog` がログの親 dir (`~/.claude/projects/<encoded>/`) を `rpcFsWatch` で監視する。jsonl は worktree の外にあり filer の app-scope watch (`useFsWatchSync`) には乗らないため、dialog が自前で watch ライフサイクルを所有する (open で watch、close / unmount で unwatch)。`fsChange` push を受けたら当該セッションの main (`relDir === ""`) / subagents (`relDir` が `<sessionId>/...`) の変更だけ拾い、250ms debounce して再読込する。再読込は `loading` を立てず `sessions` を差し替えるだけのサイレント更新で、transcript の remount とスクロール状態リセットを避ける (`:key` は同一 sessionId で安定)。`/fs/watch` は冪等な native `FSWatchRegistry` を worktree watch と共有するため、別 dir の watch が共存しても衝突しない
- **ボトム追従**: ライブ更新で `parsed` が差し替わるたび、更新前にボトム付近にいた場合だけボトムへ追従する (ターミナル / ログビューア標準の sticky bottom)。スクロールバック中は追従せず本文下部に sticky 配置の `New updates` ボタンを出し、クリックで最新へ飛ばす。初回 mount もボトム表示。markdown は async 描画で高さが後から確定するため追従要求を保留し描画完了後に再適用する。subagent の時刻ジャンプが同時に立った場合は明示操作を優先する
