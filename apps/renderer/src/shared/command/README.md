# command feature 内部設計

コマンドレジストリ、keybinding、context key の実装詳細。
機能全体の設計は [docs/command.md](../../../../docs/command.md) と [docs/keybinding.md](../../../../docs/keybinding.md) を参照。

## モジュール構成

```
types.ts                 ← 型定義の集約（循環 import 防止）
useCommandRegistry.ts    ← コマンドレジストリ（module singleton）
useContextKeys.ts        ← context key 管理（module singleton）
useKeyBindings.ts        ← keydown listener + ディスパッチ
parseKeyStroke.ts        ← key 文字列 → KeyStroke 変換
parseWhen.ts             ← when 文字列 → When AST 変換
defaultKeyBindings.json  ← デフォルト keybinding 定義
```

## types.ts — 型の集約

全モジュールの型をこのファイルに集約し、循環 import を防ぐ。

- `CommandHandler` — `(args?) => boolean`。handled 契約
- `KeyStroke` — e.code ベースの物理キー表現（code + modifier flags）
- `ContextMap` — context key 名と値型のマッピング。新しい context key はここに追加する
- `When` — 条件式の AST。`key` / `not` / `and` / `or` の tagged union
- `KeyBinding` — JSON 互換の keybinding 定義（key, command, when は文字列、args は任意の JSON 値）

## parseKeyStroke — key 文字列の変換

`"alt+cmd+up"` → `KeyStroke { code: "ArrowUp", alt: true, meta: true, ... }` に変換する。

### 変換ルール

- `+` でトークン分割し、最後のトークンが key、それ以前が modifier
- modifier のエイリアス: `cmd`/`meta`/`win` → meta、`ctrl`/`control` → ctrl、`alt`/`opt`/`option` → alt
- key トークンは `KEY_TO_CODE` マップで e.code 値に変換
- 角括弧記法 `[BracketLeft]` は e.code を直接指定（大文字を保持）
- modifier 名が末尾に来た場合はエラー（設定ミス検出）

### eventToKeyStroke

`KeyboardEvent` → `KeyStroke` 変換。引数は `Pick<KeyboardEvent, ...>` でテストしやすくしている。

## parseWhen — when 条件パーサー

再帰下降パーサーで when 文字列を `When` AST に変換する。

### 文法

```
expr     = orExpr
orExpr   = andExpr ("||" andExpr)*
andExpr  = atom ("&&" atom)*
atom     = "!" atom | contextKey
```

- `&&` は `||` より結合が強い（VS Code 互換）
- 括弧はサポートしない
- `KNOWN_KEYS` セットで未知の context key をコンパイル時に検出

### トークナイザ

`tokenize()` が入力を `&&`, `||`, `!`, 識別子 に分割する。空白はスキップ。

## useContextKeys — context key の評価

`ref<ContextMap>` で Vue のリアクティビティシステムと統合（コンテキスト全体を 1 つの ref で持ち、`set()` 時に該当 key を上書きする）。

- `set(key, value)` で更新
- `evaluate(when)` で When AST を現在の state で再帰評価
- `undefined` は常に true（when なし = 無条件）

## useKeyBindings — ディスパッチ

keydown listener（capture phase）を**ウィンドウごとの document** に張り、解決系（binding テーブル + context key + command registry）は単一を共有する。main window は `useKeyBindings()`（App.vue で 1 回）、child window は `useWindowKeyBindings(win)`（ウィンドウ生成側コンポーネントの setup で呼び、listener 寿命はその effect scope に載る）。

### 除外判定（shouldHandle）

キーイベントをコマンドシステムで処理すべきか判定する。以下は除外:

- `e.defaultPrevented` — 他の capture listener が処理済み
- `e.isComposing` — 日本語入力中
- `e.repeat` — 連打

「macOS 予約キー (Cmd+C/V/X 等)」のような特殊なホワイトリストは持たない。bind されていないキーは matching ループで unmatch となり `preventDefault()` を呼ばずに抜けるため、ブラウザ既定 (コピー / ペースト等) が自然に動く。Cmd+C 等を上書きしたければそのまま bind すればよい (自己責任)。

input/textarea/contenteditable のフォーカス除外は `shouldHandle` 内では行わない。`focusin`/`focusout` で `inputFocused` context key を更新し、各 keybinding 側が `when` 句（例: `terminalFocus && !inputFocused`）で gating する設計（VS Code の `inputFocus` と同じパターン）。

### 照合

`resolveBindings()` で JSON → `ResolvedBinding[]` に事前変換し、keydown 時は逆順走査で最初にマッチしたエントリを実行する。unbind エントリは `unboundCommands` Set で追跡し、後続の通常エントリをスキップする。
