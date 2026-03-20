# Keybinding

VS Code 互換の keybinding システム。JSON 設定からキー入力をコマンドにマッピングする。コマンドシステムの詳細は [command.md](command.md) を参照。

## キー入力の解決（e.code ベース）

`e.key` はキーボードレイアウトに依存するため使用しない。`e.code`（物理キー）で照合する。

| 操作                  | `e.key` | `e.code`        | 設定文字列      |
| --------------------- | ------- | --------------- | --------------- |
| D を押す              | `"d"`   | `"KeyD"`        | `d`             |
| Shift+2 を押す（US）  | `"@"`   | `"Digit2"`      | `2`             |
| Shift+2 を押す（JIS） | `""`    | `"Digit2"`      | `2`             |
| JIS で @ を押す       | `"@"`   | `"BracketLeft"` | `[BracketLeft]` |

> [!NOTE]
> `e.key` はレイアウト依存で Shift+2 が `@` や `"` になるが、`e.code` は常に `Digit2`

## 設定フォーマット（VS Code 互換）

JSON で定義する。`key` / `command` / `when` は文字列、`args` は任意の JSON 値。

```json
[
  { "key": "cmd+d", "command": "terminal.splitHorizontal", "when": "terminalFocus" },
  { "key": "shift+cmd+d", "command": "terminal.splitVertical", "when": "terminalFocus" },
  { "key": "cmd+w", "command": "terminal.closePane", "when": "terminalFocus" },
  { "key": "alt+cmd+left", "command": "terminal.focusLeft", "when": "terminalFocus" }
]
```

### key フィールド

modifier + key を `+` で結合。全て小文字。

**modifier:** `ctrl`, `shift`, `alt`, `cmd`（`meta`, `opt`, `win` も可）

**key 名と e.code の変換:**

| 設定の key 名                                             | e.code 値                                            |
| --------------------------------------------------------- | ---------------------------------------------------- |
| `a` - `z`                                                 | `KeyA` - `KeyZ`                                      |
| `0` - `9`                                                 | `Digit0` - `Digit9`                                  |
| `up` / `down` / `left` / `right`                          | `ArrowUp` / `ArrowDown` / `ArrowLeft` / `ArrowRight` |
| `enter`, `escape`, `tab`, `space`                         | `Enter`, `Escape`, `Tab`, `Space`                    |
| `f1` - `f12`                                              | `F1` - `F12`                                         |
| `;`, `=`, `-`, `.`, `/`, `` ` ``, `[`, `]`, `\`, `'`, `,` | `Semicolon`, `Equal`, `Minus` 等                     |

**角括弧記法:** `[BracketLeft]` のように e.code 値を直接指定できる。レイアウト依存のキーに使用する。

### command フィールド

コマンド ID。`-` prefix で unbind（既存 binding の打ち消し）。

```json
{ "key": "cmd+w", "command": "-terminal.closePane", "when": "terminalFocus" }
```

### args フィールド

コマンドハンドラーに渡す引数。省略可。同一コマンドを異なる引数で呼び分ける場合に使用する。

```json
[
  { "key": "ctrl+1", "command": "workspace.selectWorktree", "args": 1 },
  { "key": "ctrl+2", "command": "workspace.selectWorktree", "args": 2 }
]
```

### when フィールド

context key の条件式。詳細は [command.md](command.md) の「When 条件」を参照。

## 解決フロー

global keydown listener（capture phase）で以下の順に処理する。

### 除外判定

- `e.defaultPrevented` → 除外
- `e.isComposing` → 除外（日本語入力中）
- `e.repeat` → 除外（連打防止）
- `terminalFocus` が false かつ target が input/textarea/contenteditable → 除外
- macOS 予約キー（Cmd+C/V/X/A/Z/Q/H/M/,）→ 除外

### ディスパッチ

keybinding テーブル（default + user を concat）を**末尾から逆順走査**する:

- keystroke 一致 + when 条件成立 → コマンド実行
- unbind（`-` prefix）に match → そのコマンドを以降の走査でスキップ
- handler が `true`（handled）を返した場合のみ `preventDefault()` + `stopPropagation()`

逆順走査により、後のエントリ（ユーザー設定）がデフォルトより優先される。
