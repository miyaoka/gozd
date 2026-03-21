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
- `clearDoneStates` は worktree フォーカス時の既読消化。`done` → `idle` に遷移する（セッションは生きている）

## フックイベントの対応

| Claude Code hook     | gozd イベント   | 遷移先                                       | 送信経路                                   |
| -------------------- | --------------- | -------------------------------------------- | ------------------------------------------ |
| `SessionStart`       | `session-start` | `idle`                                       | nc 直接送信                                |
| `SessionEnd`         | `session-end`   | `undefined`（エントリ削除）                  | nc 直接送信                                |
| `UserPromptSubmit`   | `running`       | `working`                                    | nc 直接送信                                |
| `Stop`               | `done`          | `done`                                       | CLI 経由（`last_assistant_message` 取得）  |
| `PermissionRequest`  | `needs-input`   | `asking`（150ms debounce）                   | CLI 経由（`tool_name`, `tool_input` 取得） |
| `PostToolUse`        | `tool-done`     | `working` 維持                               | nc 直接送信                                |
| `PostToolUseFailure` | `tool-failure`  | `working` 維持 / `idle`（`is_interrupt` 時） | CLI 経由（`is_interrupt` 取得）            |
| `StopFailure`        | `stop-failure`  | `done`（API エラーによる停止）               | CLI 経由（`last_assistant_message` 取得）  |

### 送信経路の選択基準

- **nc 直接送信**: 軽量。stdin データ不要で発火頻度の高いイベント向け
- **CLI 経由**: stdin の JSON をパースして payload にマージ。詳細データが必要なイベント向け

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

| ファイル                                                       | 責務                                             |
| -------------------------------------------------------------- | ------------------------------------------------ |
| `apps/desktop/src/claudeHooks.ts`                              | hooks 設定 JSON の生成                           |
| `apps/cli/src/commands/hook.ts`                                | CLI の hook サブコマンド（stdin → ソケット転送） |
| `apps/renderer/src/features/terminal/useTerminalStore.ts`      | 状態管理（`handleHookEvent`、interrupt 検知）    |
| `apps/renderer/src/features/terminal/TerminalLeaf.vue`         | ターミナル右上のインジケーター                   |
| `apps/renderer/src/features/sidebar/worktree/WorktreeItem.vue` | サイドバーのバッジ・吹き出し                     |
