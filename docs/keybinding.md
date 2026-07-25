# Keybinding

キー入力をコマンドにマッピングする。key / when の書式は VS Code 互換。コマンドシステムの詳細は [command.md](command.md) を参照。

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

## 既定 keybinding の宣言

既定のキー割り当ては **コマンド記述子の `keybinding` フィールド** に書く（`register()` と同じ場所）。
キー割り当てだけを列挙した独立テーブルは持たない。

```typescript
registry.register("terminal.splitHorizontal", {
  label: "Terminal: Split Horizontal",
  keybinding: { key: "cmd+d", when: "terminalFocus" },
  handler: () => { ... },
});
```

コマンド ID を書く欄は `register()` の第 1 引数だけなので、ID の改名でキー割り当てとパレットの
キー表示がずれる状態を作れない。キー割り当ての寿命はコマンドの登録寿命と一致し、pane の
mount / unmount で条件付きに登録されるコマンドはキーも同時に出入りする（未登録コマンドを指す
キー割り当てが残らない）。

VS Code が既定 keybinding をコマンドと同じ descriptor（`registerCommandAndKeybindingRule` /
`Action2` の `desc.keybinding`）で登録し、JSON をユーザー設定層専用にしているのと同じ切り分け。

ユーザー設定層は持たない。既定 keybinding の宣言元はコマンド記述子だけで、キー割り当てを外部
ファイルから足す / 打ち消す経路は無い。

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

### when フィールド

context key の条件式（省略可）。詳細は [command.md](command.md) の「When 条件」を参照。

キーが発火する**実効条件**は `when` とコマンドの `precondition` の AND（VS Code の
`registerAction2` が `ContextKeyExpr.and(precondition, keybinding.when)` を組むのと同じ）。よって
precondition で既に効いている key を `when` に再掲しない（`childWindow.close` の precondition は
`childWindowFocused` なので、その keybinding に when は要らない）。

同一キーを複数のコマンドに割り当てるときは、**実効条件が同時に真にならないように書く**。
優先度（VS Code の `KeybindingWeight`）は持たない。ウィンドウのスコープで分かれる Cmd+W / Cmd+S は
`childWindowFocused` の有無で排他にしている。VS Code も auxiliary window（別 OS ウィンドウに
切り出したエディタ）については weight ではなく `IsAuxiliaryWindowFocusedContext.toNegated()` で
main window 側の割り当てを外す。

## 解決フロー

keydown listener（capture phase）で以下の順に処理する。listener は**全ウィンドウの document に張り、解決系（command registry + context key）は単一を共有する**（VS Code が `onDidRegisterWindow` で全ウィンドウに同一 dispatcher を張るのと同じ構造）。main window は App.vue の `useKeyBindings()`、undock child window は ChildWindow の `useWindowKeyBindings(win)` が配線する。child 固有の割り当て（`childWindow.close` / `childWindow.save`）は `childWindowFocused` で分岐し、同じキーを持つ main window 側（`terminal.closePane` / `preview.close` / `preview.save`）が `!childWindowFocused` を持つことで排他になる。コマンドの対象になる「フォーカス中の child window」は floating-window の childWindowCommands が OS の focus / blur で追跡する。

### 除外判定

- `e.defaultPrevented` → 除外
- `e.isComposing` → 除外（日本語入力中）
- `e.repeat` → 除外（連打防止）

> [!NOTE]
> 「macOS 予約キー (Cmd+C/V/X 等)」をハードコードで除外する仕組みは持たない。bind されていないキーは照合で unmatch となり、`preventDefault()` を呼ばないためブラウザ既定 (コピー / ペースト等) がそのまま動く。bind すれば上書き可能。
>
> 例外: application menu の accelerator に bind されたキー (Cmd+Q の Quit、Cmd+H の Hide、Cmd+M の Minimize 等) は JS handler に届く前に処理されるため bind 不可。menu 構成は `apps/electron/src/menu.ts`（role ベース）。Cmd+W は renderer 側コマンド（`preview.close` / `floatingWindow.close` / `floatingWindow.closeFront` / `terminal.closePane` / `childWindow.close`）に割り当てているため、menu には fileMenu（中身が Close Window = Cmd+W のみ）を置かない。Electron の menu accelerator は renderer の keydown より優先されるため、menu から外すのが唯一の共存手段。

### ディスパッチ

registry の `resolveKeyBinding(stroke)` が登録済みコマンドを走査し、keystroke が一致して実効条件が
成立したものを `execute()` する。handler が `true`（handled）を返した場合のみ `preventDefault()` +
`stopPropagation()`。一致する割り当てが無ければ何もしない（`preventDefault()` を呼ばないので
ブラウザ既定に抜ける）。

優先度で解く仕組みは持たない。VS Code は `KeybindingWeight` → command id → 登録順で全割り当てを
sort して逆順走査するが、あれは editor / workbench / 拡張という**登録元の層**が複数あり、
同時可視のウィジェット同士（suggest / snippet / find が Escape を取り合う等）を when だけでは
書き分けられないための機構。gozd の割り当ては 1 層で、競合はすべて context key で排他にできる。

排他の契約が破れて複数が一致した場合、先頭を実行したうえでエラー通知に流す。どちらが勝つかは
登録順（= コンポーネントの mount 順）に依存して再現しないため、黙って握りつぶさない。
