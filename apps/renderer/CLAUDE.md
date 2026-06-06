## デザイントークン / UI 規律

- 色は **semantic token** だけを使う。生 Tailwind palette (`zinc-*` / `blue-*` / `red-*` / `white` / `black` / etc.) は禁止
- Token 一覧と OKLCH 物理値の SSOT は [`src/assets/main.css`](src/assets/main.css) の `@theme` ブロック
- UI を書く / 直すときの一覧規律は project-local skill [`/.claude/skills/gozd-ui/SKILL.md`](../../.claude/skills/gozd-ui/SKILL.md) を参照 (Claude Code 自動適用)
- 不足 token は raw に逃げず、`@theme` に variable を追加する

## 検証コマンド

- package 単位の検証は `pnpm run test` / `pnpm run typecheck`

## エラーハンドリング

- 例外処理では必ず `useNotificationStore` の `error(message, cause?)` / `info(message, cause?)` でトースト通知する。`console.error` で握りつぶさない
- store 内部で `console.error` / `console.info` を出力するため、呼び出し側で console を呼ぶ必要はない
- cause にエラーオブジェクトを渡すとコンソールにスタックトレースが出る。トースト本文をクリックすると `cause` の詳細（`Error` なら `name: message` 行 + stack、それ以外は文字列化）を展開表示し、Copy ボタンで内容をクリップボードにコピーできる。WebKit/JavaScriptCore の `Error.stack` は先頭の `name: message` 行を含まないため、含まれていなければ補完する

## イベントリスナー

- `addEventListener` を直接使わず、VueUse の `useEventListener` を使う
- コンポーネントの unmount や HMR 時に effect scope が破棄されて自動解除されるため、listener のリークを防げる

## CSS クラス名

- Tailwind ユーティリティ以外のカスタム CSS クラスには `_` プレフィックスを付ける（例: `_markdown-body`, `_line-numbered`）
- ESLint の `better-tailwindcss/no-unknown-classes` ルールで `_.*` パターンが除外設定されている

## コンポーネント間通信

- `defineExpose` は使わない。親から子の内部メソッドを呼ぶ設計を避ける
- コンポーネントの機能を外部に公開する場合は composable（module singleton）パターンを使う

## コンポーネント分割

- テンプレート内で関数の戻り値を複数回参照したり、computed を組み合わせて複雑になる場合はコンポーネントに分離する
- 分離先のコンポーネントで computed を使い、テンプレートは単純な参照のみにする
- 「テンプレートで複雑なことをしない」が原則。ロジックは `<script>` 側に閉じ込める

## UI テキスト

- ユーザーに表示するすべてのテキスト（ラベル、placeholder、aria-label、title、alert メッセージ、エラーメッセージ等）は英語で書く

## `<doc>` ブロック

Vue SFC にコンポーネントのドキュメントを同居させるカスタムブロック。
`@miyaoka/vite-plugin-doc-block` がビルド時に除去するため、バンドルサイズに影響しない。

### 書き方

- 冒頭にコンポーネントの概要を一文で書く
- 必要に応じて `##` セクション + 箇条書きで補足する
- ファイル名から自明なタイトル（`# ComponentName`）は書かない
- Props など実装から読み取れる情報は書かない

```vue
<doc lang="md">
概要の一文。

## セクション名

- 箇条書きで補足
</doc>
```
