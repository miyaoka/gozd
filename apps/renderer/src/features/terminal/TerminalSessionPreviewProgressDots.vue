<doc lang="md">
セッションプレビュー (TerminalSessionPreview) の「進行中」インジケータ吹き出し。

直近の発言以降に積まれたアクション (thinking / tool) の件数を `・` の数で示し、末尾の 1 点
だけ blink させる (`_fx-blink-dot`。ターミナルの cursor と同じ discrete な on/off)。点の数が
実際の作業量の投影になるため、「止まっているのか進んでいるのか」をアニメーション速度では
なく数で読める。blink を末尾 1 点に限るのは、増える先端がどこかを示しつつ全体が明滅して数が
読めなくなるのを避けるため。

`・` を 1 文字ずつ要素に分けて `flex-wrap` で折り返す。テキストの連続文字として置くと
折り返せない: `・` (U+30FB) は UAX #14 の line break class が NS (Nonstarter) で直前での
改行が禁止されるため、`・・・・・` は 1 単語として吹き出しから溢れる。1 点 = 1 要素なら
改行規則に依存せず決定的に折り返る。

件数に上限は設けない。点の数はアクション件数そのものの投影で、頭打ちにすると「増えていない」
状態と区別が付かなくなる。伸びた吹き出しは overlay 側の `max-h` + `overflow-y-auto` が
受け止める。
</doc>

<script setup lang="ts">
interface Props {
  /** 直近の発言以降のアクション件数 (`countInProgressActions`)。1 以上のときだけ描画される想定 */
  count: number;
}

defineProps<Props>();
</script>

<template>
  <div class="flex min-w-0">
    <!-- 会話バブルの続きに見えるよう assistant 側と同じ吹き出し -->
    <div
      class="flex max-w-[85%] flex-wrap rounded-lg bg-chat-incoming px-2 py-1 text-chat-incoming-text"
      role="status"
      :aria-label="`Working: ${count} actions`"
    >
      <span v-for="i in count" :key="i" :class="i === count ? '_fx-blink-dot' : ''">・</span>
    </div>
  </div>
</template>
