## イベントリスナー

- `addEventListener` を直接使わず、VueUse の `useEventListener` を使う
- コンポーネントの unmount や HMR 時に effect scope が破棄されて自動解除されるため、listener のリークを防げる

## CSS クラス名

- Tailwind ユーティリティ以外のカスタム CSS クラスには `_` プレフィックスを付ける（例: `_markdown-body`, `_line-numbered`）
- ESLint の `better-tailwindcss/no-unknown-classes` ルールで `_.*` パターンが除外設定されている

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
