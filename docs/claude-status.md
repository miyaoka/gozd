# Claude ステータス管理

Claude Code エージェントの状態を検知し、ターミナル・サイドバーに表示する仕組み。

## 状態定義

`undefined`（エントリなし）は Claude 未起動を表す。

| 状態        | 意味                                        | 通知 | UI                              |
| ----------- | ------------------------------------------- | ---- | ------------------------------- |
| `undefined` | Claude 未起動（PTY はあるがセッションなし） | 不要 | インジケーターなし              |
| `idle`      | セッション開始済み、プロンプト待ち          | 不要 | 灰色ドット                      |
| `working`   | エージェント作業中                          | 不要 | 黄色スピナー + 経過時間         |
| `asking`    | 承認待ち（PermissionRequest）               | 必要 | オレンジバウンス                |
| `done`      | 応答完了、人間の確認待ち                    | 必要 | 緑バウンス + メッセージ吹き出し |

## 状態遷移

```text
undefined ──SessionStart──→ idle ──UserPromptSubmit──→ working ──→ asking
                              ↑                          ↑    ↗        │
                              │                          └──tool-done──┘
                              │                          │
                              ├──PTY出力 "Interrupted"───┘
                              │                          │
                              │                          ↓
                            idle ←──clearDoneStates─── done
                              │
                     ptyExit / SessionEnd
                              ↓
                           undefined
```

- `done` → 次の `UserPromptSubmit` で直接 `working` に遷移する（`idle` を経由しない）
- `clearDoneStates` は worktree 選択時の既読消化。`done` → `idle` に遷移する（セッションは生きている）
- 発火点は `worktreeStore.setOpen` 一箇所。サイドバーのクリック・ターミナル focus などすべての wt 選択経路が `setOpen` を経由し、`useWorktreeStore` の `selectionVersion` カウンタを上げる。`useSidebarData` がそのカウンタを watch して `terminalStore.clearDoneStates(worktreeStore.dir)` を呼ぶ（claude status の所有者は terminal だが、両 store 参照を持つ `useSidebarData` に集約することで barrel 経由の循環を避ける）

## フックイベントの対応

| Claude Code hook     | gozd イベント   | 遷移先                                        | 送信経路                                                      |
| -------------------- | --------------- | --------------------------------------------- | ------------------------------------------------------------- |
| `SessionStart`       | `session-start` | `idle`                                        | CLI 経由（`session_id`, `source` 取得 / resume 永続化のため） |
| `SessionEnd`         | `session-end`   | `undefined`（エントリ削除）                   | CLI 経由（`session_id` で永続化エントリを削除するため）       |
| `UserPromptSubmit`   | `running`       | `working`                                     | nc 直接送信                                                   |
| `Stop`               | `done`          | `done`（pending work 時は表示のみ `working`） | CLI 経由（`last_assistant_message` / pending work 取得）      |
| `PermissionRequest`  | `needs-input`   | `asking`（150ms debounce）                    | CLI 経由（`tool_name`, `tool_input` 取得）                    |
| `PostToolUse`        | `tool-done`     | `working` 維持                                | nc 直接送信                                                   |
| `PostToolUseFailure` | `tool-failure`  | `working` 維持 / `idle`（`is_interrupt` 時）  | CLI 経由（`is_interrupt` 取得）                               |
| `StopFailure`        | `stop-failure`  | `done`（API エラーによる停止）                | CLI 経由（`last_assistant_message` 取得）                     |

### 送信経路の選択基準

- **nc 直接送信**: 軽量。stdin データ不要で発火頻度の高いイベント向け
- **CLI 経由**: stdin の JSON をパースして payload にマージ。詳細データが必要なイベント向け

### PermissionRequest debounce の cancel 経路

`needs-input` 受信時に `setTimeout(150ms)` でタイマーを張り、満了時に `asking` へ遷移する。タイマー満了前に **`running` / `done` / `tool-done` / `tool-failure` / `session-end` / `stop-failure`** のいずれかが来ると `cancelAskTimer(ptyId)` でタイマーを破棄する。

これにより「自動承認で一瞬で抜けるツール呼び出し（tool-done が即来る）」では `asking` バッジが瞬きせず、人間が本当に止まる承認だけが UI に出る。debounce 中に `session-end` で当該 PTY のエントリが消えていた場合は、タイマー満了時に遷移を中止する。

## interrupt 検知の制約

> [!WARNING]
> Claude Code にはユーザー中断（Ctrl+C/Escape）を通知するフックが存在しない。
> `Stop` も `PostToolUseFailure` もテキスト生成中の中断では発火しない（`anthropics/claude-code` #9516 で要望中）。

### 検知方法

| 中断タイミング | 検知方法                                          | 信頼性                                                 |
| -------------- | ------------------------------------------------- | ------------------------------------------------------ |
| ツール実行中   | `PostToolUseFailure` の `is_interrupt: true`      | 高（ただし発生頻度は低い。ツールは高速に完了するため） |
| テキスト生成中 | PTY 出力の `"⎿ \u00A0Interrupted"` パターンマッチ | 中（Claude Code の UI 変更で壊れる可能性あり）         |
| PTY 終了       | `onPtyExit` イベント                              | 高（プロセスレベルの検知）                             |

### PTY 出力パターンマッチの詳細

Claude Code は中断時に以下の文字列を PTY に出力する:

```text
⎿ <NBSP>Interrupted · What should Claude do instead?
```

- `⎿` (U+23BF): Claude Code のツール出力プレフィックス
- 空白: SP (U+0020) + NBSP (U+00A0)
- `working` 状態の PTY データに対してのみマッチを行い、`idle` に遷移させる

## 真の done と「background 待ちの偽 done」の区別

`Stop` は「セッション終了」ではなく「主エージェントのターン終了」で発火する。エージェントが background 実行（`run_in_background` の Bash / 非同期 Agent / Monitor）や scheduled wakeup（`/loop` / `ScheduleWakeup` / `CronCreate`）を起動するとその時点でターンが終わり `Stop` が飛ぶが、裏の作業が完了すると Claude は自動で再起動する。このとき緑バッジ・音声通知を出すと、人間は「終わった」と誤認する。

foreground subagent（Task tool の同期実行）はサブエージェント完了まで主エージェントの `Stop` を出さない（完了は別系統の `SubagentStop`。gozd は登録していない）。よって偽 done の構造的な発生源は **background 系だけ** に限定される。

区別の信号は `Stop` フックの stdin（Claude Code v2.1.145+）に乗る 2 配列:

- `background_tasks`: 走行中の background process（`run_in_background` / 非同期 Agent / Monitor）
- `session_crons`: 予約された再起動（`/loop` / `ScheduleWakeup` / `CronCreate`）

CLI が 2 配列の length を OR で畳んで `pending_work` 信号を立て、状態判定に渡す。

`pending_work` が立っていても **状態は常に `done` に倒す**。`pending_work` は `ClaudeStatus` の `done` バリアントに flag として保持し、表示層が `displayClaudeState()` 経由で `done + pendingWork` を `working` として描画して緑バッジ・吹き出し・音声を抑止する。pending が空になった本物の `Stop`（次のターン終了）で `pendingWork` が落ち、表示が `working` → `done` に切り替わる。

`working` を直接維持せず必ず `done` を経由させる理由は **状態固着の回避**。`Stop` 後に Claude が再起動しないケース（background 完了通知の欠落 / 予約再起動の不発）では「次の `Stop`」が永久に来ない。`working` を維持するとその状態に張り付き、`done` でしか効かない `clearDoneStates`（フォーカス時の既読消化）での消化経路も失う。`done` を経由させることで、再起動が来なくてもフォーカスで `idle` に消化でき、完了通知が永久に出ない事故を防ぐ。

判定（`done + pendingWork` を完了扱いしない）は表示の `displayClaudeState()` と音声の `speechText.ts` の 2 経路に出るが、いずれも SSOT である proto の `pending_work` フィールド 1 つを参照する。

> [!NOTE]
> 旧バージョン（v2.1.145 未満）の Claude Code は両キーを stdin に乗せないが、CLI は欠落を count 0（= pending なし）として扱うため、その場合は従来どおり `pendingWork` なしの `done` になる（欠落 == 空で正しい挙動）。

## サイドバーの表示ルール

worktree に複数ターミナルがある場合、`ClaudeState` の優先度順にソートして表示する。

| 状態      | 優先度    |
| --------- | --------- |
| `asking`  | 3（最高） |
| `working` | 2         |
| `done`    | 1         |
| `idle`    | 0（最低） |

### Stop 時の表示

- `done` 状態は `last_assistant_message` の一行目を吹き出しで表示する
- `asking` で `AskUserQuestion` の場合は質問テキストを吹き出しで表示する

## 関連ファイル

| ファイル                                                       | 責務                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/native/Sources/GozdCore/ClaudeHooksSettings.swift`       | hooks 設定 JSON の生成                                                  |
| `apps/native/Sources/GozdCLI/main.swift`                       | CLI の hook サブコマンド（stdin → ソケット転送）                        |
| `apps/renderer/src/features/terminal/useTerminalStore.ts`      | 状態管理（`handleHookEvent`、interrupt 検知）                           |
| `apps/renderer/src/features/terminal/TerminalLeafTitle.vue`    | leaf ヘッダの status アイコン + Task タイトル（TaskRow と同一の見た目） |
| `apps/renderer/src/features/sidebar/worktree/WorktreeItem.vue` | サイドバーのバッジ・吹き出し                                            |
