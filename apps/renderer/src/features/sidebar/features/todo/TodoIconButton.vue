<doc lang="md">
Todo アイコンをクリックして変更するボタン。クリックで popover ピッカーを表示し、選択で即座に emit する。

## 表示

- アイコン設定済み: emoji をそのまま表示
- 未設定: default slot の内容を表示（呼び出し元がフォールバックを決める）

## popover

CSS Anchor Positioning で button 直下に配置。`popover="auto"` で外部クリック時に自動で閉じる。
</doc>

<script setup lang="ts">
import { TODO_ICONS } from "@gozd/rpc";
import { useId, useTemplateRef } from "vue";

const props = defineProps<{
  icon: string | undefined;
}>();

const emit = defineEmits<{
  update: [icon: string | undefined];
}>();

const id = useId();
const anchorName = `--todo-icon-${id}`;
const popoverId = `todo-icon-popover-${id}`;
const popoverRef = useTemplateRef<HTMLElement>("popover");

function toggle(emoji: string) {
  const next = props.icon === emoji ? undefined : emoji;
  emit("update", next);
  popoverRef.value?.hidePopover();
}
</script>

<template>
  <button
    type="button"
    aria-label="Change todo icon"
    aria-haspopup="true"
    class="relative z-10 row-span-2 mt-0.5 text-base transition-transform hover:scale-125"
    :style="{ anchorName }"
    :popovertarget="popoverId"
  >
    <template v-if="icon">{{ icon }}</template>
    <slot v-else />
  </button>
  <div
    :id="popoverId"
    ref="popover"
    popover="auto"
    class="m-0 rounded-lg border border-zinc-700 bg-zinc-900 p-1.5 shadow-lg"
    :style="{
      positionAnchor: anchorName,
      top: 'anchor(bottom)',
      left: 'anchor(left)',
    }"
  >
    <div class="flex flex-wrap gap-0.5" role="group" aria-label="Todo icon">
      <button
        v-for="ic in TODO_ICONS"
        :key="ic.emoji"
        type="button"
        :title="ic.title"
        :aria-label="ic.title"
        :aria-pressed="icon === ic.emoji"
        class="rounded-sm px-1 py-0.5 text-sm hover:bg-zinc-700"
        :class="
          icon === ic.emoji ? 'bg-zinc-600 ring-1 ring-blue-500' : 'opacity-60 hover:opacity-100'
        "
        @click="toggle(ic.emoji)"
      >
        {{ ic.emoji }}
      </button>
    </div>
  </div>
</template>

<style scoped>
[popover] {
  position: fixed;
  position-try-fallbacks: flip-block, flip-inline;
}
</style>
