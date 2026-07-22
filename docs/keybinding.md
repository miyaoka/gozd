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

コマンドハンドラーに渡す引数。省略可。同一コマンドを異なる引数で呼び分ける場合に使用する（registry の `execute(id, args)` の第 2 引数として handler に届く）。

```json
[
  { "key": "ctrl+1", "command": "foo.bar", "args": 1 },
  { "key": "ctrl+2", "command": "foo.bar", "args": 2 }
]
```

### when フィールド

context key の条件式。詳細は [command.md](command.md) の「When 条件」を参照。

## 解決フロー

keydown listener（capture phase）で以下の順に処理する。listener は**全ウィンドウの document に張り、解決系（binding テーブル + context key + command registry）は単一を共有する**（VS Code が `onDidRegisterWindow` で全ウィンドウに同一 dispatcher を張るのと同じ構造）。main window は App.vue の `useKeyBindings()`、undock child window は ChildWindow の `useWindowKeyBindings(win)` が配線する。child 固有の割り当て（`childWindow.close` / `childWindow.save`）は `childWindowFocused` context key の when 条件で分岐し、テーブル末尾（高優先）に置く。コマンドの対象になる「フォーカス中の child window」は floating-window の childWindowCommands が OS の focus / blur で追跡する。

### 除外判定

- `e.defaultPrevented` → 除外
- `e.isComposing` → 除外（日本語入力中）
- `e.repeat` → 除外（連打防止）

> [!NOTE]
> 「macOS 予約キー (Cmd+C/V/X 等)」をハードコードで除外する仕組みは持たない。bind されていないキーは matching ループで unmatch となり、`preventDefault()` を呼ばないためブラウザ既定 (コピー / ペースト等) がそのまま動く。bind すれば上書き可能。
>
> 例外: application menu の accelerator に bind されたキー (Cmd+Q の Quit、Cmd+H の Hide、Cmd+M の Minimize 等) は JS handler に届く前に処理されるため bind 不可。menu 構成は `apps/electron/src/menu.ts`（role ベース）。Cmd+W は `defaultKeyBindings.json` で renderer 側コマンド（`preview.close` / `floatingWindow.closeFront` / `terminal.closePane`）に割り当てているため、menu には fileMenu（中身が Close Window = Cmd+W のみ）を置かない。Electron の menu accelerator は renderer の keydown より優先されるため、menu から外すのが唯一の共存手段。

### ディスパッチ

keybinding テーブル（default + user を concat）を**末尾から逆順走査**する:

- keystroke 一致 + when 条件成立 → コマンド実行
- unbind（`-` prefix）に match → そのコマンドを以降の走査でスキップ
- handler が `true`（handled）を返した場合のみ `preventDefault()` + `stopPropagation()`

逆順走査により、後のエントリ（ユーザー設定）がデフォルトより優先される。
