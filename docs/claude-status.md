# Claude ステータス管理

Claude Code エージェントの状態を検知し、ターミナル・サイドバーに表示する仕組み。

## 状態定義

`undefined`（エントリなし）は Claude 未起動を表す。

| 状態        | 意味                                        | 通知 | UI                                    |
| ----------- | ------------------------------------------- | ---- | ------------------------------------- |
| `undefined` | Claude 未起動（PTY はあるがセッションなし） | 不要 | インジケーターなし                    |
| `idle`      | セッション開始済み、プロンプト待ち          | 不要 | 緑の塗り丸（ターミナルが生きている）  |
| `working`   | エージェント作業中                          | 不要 | 隙間ありリング + spin + 経過時間      |
| `asking`    | 承認待ち（PermissionRequest）               | 必要 | 橙の塗り丸 + pulse                    |
| `done`      | 応答完了、人間の確認待ち                    | 必要 | 緑チェックマーク + メッセージ吹き出し |

## 状態遷移

```text
undefined ──SessionStart──→ idle ──OSC: スピナー──→ working ──PermissionRequest──→ asking
                              ↑                       ↑    ↖                          │
                              │                       │     └──OSC: スピナー（承認後）─┘
                              ├──OSC: "✳"─────────────┘
                              │  (中断 / プロンプト復帰)  │
                              │                       ↓ Stop
                            idle ←──clearDoneStates─── done
                              │
                     ptyExit / SessionEnd
                              ↓
                           undefined
```

- **working / idle は OSC タイトルのプレフィックス（スピナー / `✳`）で駆動する**（herdr 方式）。`UserPromptSubmit` / `PostToolUse` / `PostToolUseFailure` hook は状態を動かさず、fx（arcade 音）発行のみに使う
- `asking`（PermissionRequest）/ `done`（Stop）/ `idle`（SessionStart）は hook が権威。OSC の `✳`（idle）は **working からの離脱時のみ**適用し、done / asking を上書きしない（未読 done を消さないため）
- `done` → 次にスピナーが出た時点で直接 `working` に遷移する（`idle` を経由しない）
- `clearDoneStates` は worktree 選択時の既読消化。`done` → `idle` に遷移する（セッションは生きている）
- 発火点は `worktreeStore.setOpen` 一箇所。サイドバーのクリック・ターミナル focus などすべての wt 選択経路が `setOpen` を経由し、`useWorktreeStore` の `selectionVersion` カウンタを上げる。`useSidebarData` がそのカウンタを watch して `terminalStore.clearDoneStates(worktreeStore.dir)` を呼ぶ（claude status の所有者は terminal だが、両 store 参照を持つ `useSidebarData` に集約することで barrel 経由の循環を避ける）

## フックイベントの対応

| Claude Code hook     | gozd イベント   | 状態への作用                                  | 送信経路                                                      |
| -------------------- | --------------- | --------------------------------------------- | ------------------------------------------------------------- |
| `SessionStart`       | `session-start` | `idle`                                        | CLI 経由（`session_id`, `source` 取得 / resume 永続化のため） |
| `SessionEnd`         | `session-end`   | `undefined`（エントリ削除）                   | CLI 経由（`session_id` で永続化エントリを削除するため）       |
| `Stop`               | `done`          | `done`（pending work 時は表示のみ `working`） | CLI 経由（`last_assistant_message` / pending work 取得）      |
| `PermissionRequest`  | `needs-input`   | `asking`（150ms debounce）                    | CLI 経由（`tool_name`, `tool_input` 取得）                    |
| `StopFailure`        | `stop-failure`  | `done`（API エラーによる停止）                | CLI 経由（`last_assistant_message` 取得）                     |
| `UserPromptSubmit`   | `running`       | **なし**（fx のみ。working は OSC タイトル）  | nc 直接送信                                                   |
| `PostToolUse`        | `tool-done`     | **なし**（fx のみ。working は OSC タイトル）  | nc 直接送信                                                   |
| `PostToolUseFailure` | `tool-failure`  | **なし**（状態も fx も無し。inert）           | CLI 経由（現状 payload 未使用）                               |

> [!NOTE]
> `running` / `tool-done` / `tool-failure` は状態を動かさない（working / idle は OSC タイトルが駆動）。`running` / `tool-done` は arcade の効果音（engage / tick）のために fx だけ発行し続ける。`tool-failure` は fx も持たず現状 inert（将来 hook 登録ごと削除可能）。

### 送信経路の選択基準

- **nc 直接送信**: 軽量。stdin データ不要で発火頻度の高いイベント向け
- **CLI 経由**: stdin の JSON をパースして payload にマージ。詳細データが必要なイベント向け

### PermissionRequest debounce の cancel 経路

`needs-input` 受信時に `setTimeout(150ms)` でタイマーを張り、満了時に `asking` へ遷移する。タイマー満了前に **`running` / `done` / `tool-done` / `tool-failure` / `session-end` / `stop-failure`** のいずれかが来ると `cancelAskTimer(ptyId)` でタイマーを破棄する。

これにより「自動承認で一瞬で抜けるツール呼び出し（tool-done が即来る）」では `asking` バッジが瞬きせず、人間が本当に止まる承認だけが UI に出る。debounce 中に `session-end` で当該 PTY のエントリが消えていた場合は、タイマー満了時に遷移を中止する。

## working / idle の検知（OSC タイトル駆動）

> [!WARNING]
> Claude Code にはユーザー中断（Ctrl+C/Escape）を通知するフックが存在しない。
> `Stop` も `PostToolUseFailure` もテキスト生成中の中断では発火しない（`anthropics/claude-code` #9516 で要望中）。

このため working / idle を hook では取らず、Claude が OSC タイトル先頭に常時出す状態プレフィックスから導出する（`observeTitle`）。中断も通常完了も「スピナー→`✳`」の 1 経路で拾えるので、中断専用の検知（PTY 出力の中断メッセージマッチや入力キー推論）が不要になる。

- Claude は稼働中はタイトル先頭に**点字スピナー（U+2800–U+28FF）**、プロンプト待ちでは **`✳`（U+2733）**を出す（いずれも直後に半角スペース）。`classifyClaudeTitle` がこのプレフィックスを working / idle に分類する
- 取得経路は `XtermTerminal.vue` の `terminal.onTitleChange`（xterm が OSC 0/2 を解析）→ `useTerminalStore.setTitle` → `observeTitle`。**全 worktree の leaf が `v-show` でマウント維持**され PTY データを処理し続けるため、非アクティブ worktree の badge も即時更新される（ポーリング不要）
- **working プレフィックスは常に `working` にする**（新ターン開始・中断後の再開の確証）。**`✳` は `working` からの離脱時のみ `idle`** に倒し、`done` / `asking` は温存する（hook 権威。未読 done を `✳` で消さない）
- サイドバーの task タイトルは同じプレフィックスを `stripClaudeTitlePrefix` で落として表示する。分類と除去は同じ文字集合を SSOT（`claudeStatus.ts`）として共有する

| 検知対象     | 検知方法                                    | 備考                                    |
| ------------ | ------------------------------------------- | --------------------------------------- |
| working/idle | OSC タイトルのスピナー / `✳` プレフィックス | 中断・通常完了・復帰をこの 1 経路で拾う |
| PTY 終了     | `onPtyExit` イベント                        | 高（プロセスレベルの検知）              |

## 真の done と「background 待ちの偽 done」の区別

`Stop` は「セッション終了」ではなく「主エージェントのターン終了」で発火する。エージェントが background 実行（`run_in_background` の Bash / 非同期 Agent / Monitor）や scheduled wakeup（`/loop` / `ScheduleWakeup` / `CronCreate`）を起動するとその時点でターンが終わり `Stop` が飛ぶが、裏の作業が完了すると Claude は自動で再起動する。このとき緑バッジ・音声通知を出すと、人間は「終わった」と誤認する。

foreground subagent（Task tool の同期実行）はサブエージェント完了まで主エージェントの `Stop` を出さない（完了は別系統の `SubagentStop`。gozd は登録していない）。よって偽 done の構造的な発生源は **background 系だけ** に限定される。

区別の信号は `Stop` フックの stdin（Claude Code v2.1.145+）に乗る 2 配列:

- `background_tasks`: 走行中の background process（`run_in_background` / 非同期 Agent / Monitor）
- `session_crons`: 予約された再起動（`/loop` / `ScheduleWakeup` / `CronCreate`）

CLI が 2 配列の length を OR で畳んで `pending_work` 信号を立て、状態判定に渡す。

`pending_work` が立っていても **状態は常に `done` に倒す**。`pending_work` は `ClaudeStatus` の `done` バリアントに flag として保持し、バッジは `displayClaudeState()` 経由で `done + pendingWork` を `working` として描画する。pending が空になった本物の `Stop`（次のターン終了）で `pendingWork` が落ち、表示が `working` → `done` に切り替わる。

`working` を直接維持せず必ず `done` を経由させる理由は **状態固着の回避**。`Stop` 後に Claude が再起動しないケース（background 完了通知の欠落 / 予約再起動の不発）では「次の `Stop`」が永久に来ない。`working` を維持するとその状態に張り付き、`done` でしか効かない `clearDoneStates`（フォーカス時の既読消化）での消化経路も失う。`done` を経由させることで、再起動が来なくてもフォーカスで `idle` に消化でき、完了通知が永久に出ない事故を防ぐ。

### 効果（音・演出・読み上げ）の抑止は claudeFx に一元化する

「`done + pendingWork` を完了扱いするか」の判断を購読者ごとに散らすと、効果購読者を増やすたび取りこぼす（実際に arcade 演出の取りこぼしが起きた）。これを防ぐため、効果は **`hook` を解釈する terminal が再発行する正規化イベント `claudeFx` 1 本** に集約する。

- `handleHookEvent` が hook を解釈した結果として `ClaudeFxEvent` を返し、`useTerminalStore` が `dispatchMessage("claudeFx", fx)` で再発行する
- pending done / dead PTY など「完了扱いしない hook」は `handleHookEvent` が `undefined` を返して落とす（**抑止判断はこの 1 箇所のみ**）
- 効果側（VOICEVOX 読み上げ・arcade の演出/効果音）は `claudeFx` を購読するだけで、`pending_work` を一切見ない。pending done は構造的に届かないため、新しい効果購読者を足しても取りこぼせない

`pendingWork` flag の **算出は `handleHookEvent` の done 分岐 1 箇所**（SSOT は proto の `pending_work` フィールド）。この flag を読む**判断点はバッジ側（`displayClaudeState()`）と効果側（fx 発行可否）の 2 経路**だが、いずれも同じ flag を参照する。バッジは表示 state、効果はイベント駆動で出力先が異なるため、責務として分離している。

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

| ファイル                                                           | 責務                                                                          |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `apps/native/Sources/GozdCore/ClaudeHooksSettings.swift`           | hooks 設定 JSON の生成                                                        |
| `apps/native/Sources/GozdCLI/main.swift`                           | CLI の hook サブコマンド（stdin → ソケット転送）                              |
| `apps/renderer/src/features/terminal/claudeStatus.ts`              | 状態管理（`handleHookEvent` + `observeTitle` による OSC タイトル駆動）        |
| `apps/renderer/src/features/terminal/XtermTerminal.vue`            | `terminal.onTitleChange` で OSC タイトルを `setTitle` → `observeTitle` に流す |
| `apps/renderer/src/features/terminal/TerminalLeafTitle.vue`        | leaf ヘッダの status アイコン + Task タイトル（TaskRow と同一の見た目）       |
| `apps/renderer/src/features/sidebar/features/worktree/WtCard.vue`  | worktree 内 Claude 状態の aura 集約                                           |
| `apps/renderer/src/features/sidebar/features/worktree/TaskRow.vue` | サイドバーの行内 status アイコン・吹き出し                                    |
