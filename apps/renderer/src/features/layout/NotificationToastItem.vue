<doc lang="md">
通知トーストの 1 アイテム。

## 動作

- toast は短文の at-a-glance 表示専用で、詳細のインライン展開は持たない
  (toast は固定幅・短時間表示という業界慣習に従い、長文を toast 内で展開しない)
- `cause` がある通知には Details ボタンを出し、notification center の該当項目を
  展開表示させて toast は畳む (詳細閲覧の受け皿は center に一本化)
- dismiss ボタンは toast を畳むだけで、通知自体は center に残る
</doc>

<script setup lang="ts">
import { useNotificationCenterStore } from "./useNotificationCenterStore";
import IconLucideCircleX from "~icons/lucide/circle-x";
import IconLucideInfo from "~icons/lucide/info";
import IconLucideTriangleAlert from "~icons/lucide/triangle-alert";
import IconLucideX from "~icons/lucide/x";

const props = defineProps<{
  id: number;
  type: "error" | "warning" | "info";
  message: string;
  /** 詳細 (cause) を持つか。true で Details ボタンを出す */
  hasDetails: boolean;
}>();

const emit = defineEmits<{ dismiss: [] }>();

const iconMap = {
  error: IconLucideCircleX,
  warning: IconLucideTriangleAlert,
  info: IconLucideInfo,
} as const;

const colorMap = {
  error: "border-destructive bg-destructive-subtle",
  warning: "border-warning bg-warning-subtle",
  info: "border-border bg-background",
} as const;

const iconColorMap = {
  error: "text-destructive-text",
  warning: "text-warning-text",
  info: "text-primary-text",
} as const;

const centerStore = useNotificationCenterStore();

function showDetails() {
  centerStore.reveal(props.id);
  emit("dismiss");
}
</script>

<template>
  <div
    :class="[
      'pointer-events-auto flex w-md max-w-md items-start gap-2 rounded-lg border p-3 text-sm text-foreground shadow-lg',
      colorMap[type],
    ]"
  >
    <component :is="iconMap[type]" :class="['mt-0.5 size-4 shrink-0', iconColorMap[type]]" />
    <span class="min-w-0 flex-1 break-all select-text">{{ message }}</span>
    <button
      v-if="hasDetails"
      type="button"
      class="min-h-6 shrink-0 cursor-pointer rounded-sm border border-border-subtle px-2 py-0.5 text-xs text-foreground hover:bg-element-hover"
      @click="showDetails"
    >
      Details
    </button>
    <button
      type="button"
      class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-foreground-low hover:text-foreground"
      aria-label="Dismiss"
      @click="$emit('dismiss')"
    >
      <IconLucideX class="size-4" />
    </button>
  </div>
</template>
