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
