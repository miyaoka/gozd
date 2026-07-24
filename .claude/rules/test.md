---
paths:
  - "**/*.test.ts"
---

# テストの規律

## bun test の対象は純粋関数

- テストしたいロジックが composable / store の中にあるなら、snapshot 入力の純粋関数に抽出してからテストする（`formatCause.ts` / `previewEditPolicy.ts` の切り方）。Vue 配線（watch・lifecycle・store 結線）はテスト対象にしない
- Vue の lifecycle 警告（`onUnmounted` 等）が出たら、テストしたい対象で分岐する: lifecycle の挙動そのものをテストしたいなら vitest（+ @vue/test-utils）、純粋ロジックなら抽出して bun。警告を握りつぶして bun で composable を回し続ける選択肢はない

## テスト実行は無出力が正常

console 出力や framework 警告が漏れるのは、テスト対象の設計かテストの書き方の欠陥であり、「観察ログなので許容」で放置しない。

- テストが踏む経路に観察ログ（`console.*`）があるなら spy で吸う。ログがその経路の契約なら、黙らせるだけでなく発火内容まで assert に昇格する
- spy が効かないときはテスト側で妥協せず実装側の束縛を疑う。module load 時に console の関数参照を掴むと spy のプロパティ差し替えが届かない。呼び出し時に `console[method]` を引く形に直す
