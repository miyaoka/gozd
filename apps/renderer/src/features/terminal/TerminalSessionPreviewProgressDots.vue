<doc lang="md">
セッションプレビュー (TerminalSessionPreview) の「進行中」インジケータ吹き出し。件数の数え方は
`countInProgressActions` の docstring が SSOT。

件数ぶんの `・` を並べ、末尾の 1 点だけ blink させる (`_fx-blink-dot`)。点の数が作業量の投影に
なるため、進んでいるのか止まっているのかをアニメーション速度ではなく数で読める。blink を末尾
1 点に限るのは、増える先端を示しつつ全体が明滅して数が読めなくなるのを避けるため。

`・` を 1 文字ずつ要素に分けて `flex-wrap` で折り返す。テキストの連続文字として置くと
折り返せない: `・` (U+30FB) は UAX #14 の line break class が NS (Nonstarter) で直前での
改行が禁止されるため、`・・・・・` は 1 単語として吹き出しから溢れる。1 点 = 1 要素なら
改行規則に依存せず決定的に折り返る。

件数に上限は設けない。点の数はアクション件数そのものの投影で、頭打ちにすると「増えていない」
状態と区別が付かなくなる。伸びた吹き出しは overlay 側の `max-h` + `overflow-y-auto` が
受け止める。

点は視覚的な装飾なので `aria-hidden` で支援技術から隠す。live region にはしない: 進行中で
あることの読み上げは leaf タイトルの ClaudeStatus badge (`CLAUDE_STATE_VISUAL` が SSOT) が
担っており、preview 側に読み上げの権威を増設すると状態の SSOT が割れる。加えて件数は
アクションごとに変わるため、live region にすると 1 手ごとに読み上げが走る。

`count === 0` のとき何も描画しないのはこのコンポーネントの責務。親側の `v-if` に出すと
同じ不変条件が呼び出し箇所ぶん散らばる。
</doc>

<script setup lang="ts">
interface Props {
  count: number;
}

defineProps<Props>();
</script>

<template>
  <div v-if="count > 0" class="flex min-w-0" aria-hidden="true">
    <!-- 会話バブルの続きに見えるよう assistant 側と同じ吹き出し -->
    <div
      class="flex max-w-[85%] flex-wrap rounded-lg bg-chat-incoming px-2 py-1 text-chat-incoming-text"
    >
      <span v-for="i in count" :key="i" :class="i === count ? '_fx-blink-dot' : ''">・</span>
    </div>
  </div>
</template>
