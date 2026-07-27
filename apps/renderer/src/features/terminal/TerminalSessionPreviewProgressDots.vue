<doc lang="md">
セッションプレビュー (TerminalSessionPreview) の「進行中」インジケータ吹き出し。件数の数え方は
`countInProgressActions` の docstring が SSOT。

件数ぶんの `・` を並べ、末尾の 1 点だけ blink させる (`_fx-blink-dot`)。点の数が作業量の投影に
なるため、進んでいるのか止まっているのかをアニメーション速度ではなく数で読める。blink を末尾
1 点に限るのは、増える先端を示しつつ全体が明滅して数が読めなくなるのを避けるため。

DOM は「先頭側の `・` 連続テキスト」+「blink する末尾 1 文字」の 2 要素で、折り返しは
`wrap-anywhere` (`overflow-wrap: anywhere`) が担う。`・` (U+30FB) は UAX #14 の line break class が
NS (Nonstarter) で直前での改行が禁止されるため、通常の折り返しでは `・・・・・` が 1 単語として
吹き出しから溢れる。`anywhere` は他に改行候補が無い行で任意点の改行を許すのでこれを上書きする
(`word-break: break-all` では上書きされず溢れたままになるので置き換えないこと。Chromium 実測)。
1 点 1 要素 + `flex-wrap` でも折り返せるが、件数に上限が無いため要素数が際限なく増える。

件数に上限は設けない。点の数はアクション件数そのものの投影で、頭打ちにすると増えているのか
どうかが読めなくなる。さらに、吹き出しが溢れるほどアクションが続いている状態そのものが異常
(暴走・ループ) の signal になる。点の列がスクロール面の可視域を占め、会話バブルが初期表示から
外れる (スクロールすれば見える) のはこの signal と引き換えに受け入れている。スクロール面は
`flex-col-reverse` で末尾 (= この吹き出し) にアンカーされるため、押し出されるのは会話側になる。

面積の成長として読めるのはスクロール面が埋まるまで。埋まった後の増加は可視域の上へクリップ
されるため面積は飽和する (閾値は leaf 寸法依存で、狭いペインでは早い)。そこから先に残るのは
「面が点で埋まっている」という状態自体で、件数の伸びは読めない。

点は視覚的な装飾なので `aria-hidden` で支援技術から隠す。live region にはしない: 進行中で
あることの読み上げは leaf タイトルの ClaudeStatus badge (`CLAUDE_STATE_VISUAL` が SSOT) が
担っており、preview 側に読み上げの権威を増設すると状態の SSOT が割れる。加えて件数は
アクションごとに変わるため、live region にすると 1 手ごとに読み上げが走る。

`count === 0` のとき何も描画しないのはこのコンポーネントの責務。親側の `v-if` に出すと
同じ不変条件が呼び出し箇所ぶん散らばる。
</doc>

<script setup lang="ts">
import { computed } from "vue";

interface Props {
  count: number;
}

const props = defineProps<Props>();

// 末尾 1 点は blink 用に別要素へ切り出すため、先頭側はまとめて 1 つのテキストにする
const leadingDots = computed(() => "・".repeat(Math.max(props.count - 1, 0)));
</script>

<template>
  <div v-if="count > 0" class="flex min-w-0" aria-hidden="true">
    <!-- 会話バブルの続きに見えるよう assistant 側と同じ吹き出し -->
    <div
      class="max-w-[85%] rounded-lg bg-chat-incoming px-2 py-1 wrap-anywhere text-chat-incoming-text"
    >
      <span>{{ leadingDots }}</span
      ><span class="_fx-blink-dot">・</span>
    </div>
  </div>
</template>
