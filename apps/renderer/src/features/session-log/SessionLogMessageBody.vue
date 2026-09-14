<doc lang="md">
発言 1 件の本文描画。session log dialog の吹き出し、terminal preview の全文 popover、
undock されたフローティングウィンドウ (UndockedLogWindow)、ダッシュボードが共有する。

- 本文は話者によらず MarkdownBody で描画し、本文の先頭に印を出す
- 本文中の HTML は要素にせず、書かれた文字のまま出す。発言の本文は会話で書かれた文字で、
  HTML として解釈すると文字が消えたり別の要素に化けたりする
- 地と文字色は持たない。consumer が吹き出しを塗る要素に `SPEAKER_SURFACE_CLASS` を当て、
  その CSS 変数を MarkdownBody が継承する
</doc>

<script setup lang="ts">
import { MarkdownBody } from "../preview";

defineProps<{
  text: string;
  /** 本文の先頭に出す印 */
  mark?: string;
}>();

const emit = defineEmits<{
  /** MarkdownBody が外部送りしなかった href */
  linkClick: [href: string];
  /** MarkdownBody の描画完了 (高さ確定に依存する consumer のフック) */
  rendered: [];
}>();
</script>

<template>
  <div class="px-3 py-2">
    <MarkdownBody
      :content="text"
      :lead-mark="mark"
      literal-html
      @link-click="emit('linkClick', $event)"
      @rendered="emit('rendered')"
    />
  </div>
</template>
