<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  completed: number;
  total: number;
  /** どの一覧の進み具合かを読み上げで区別する名前。undefined なら装飾として読み上げから外す
   * （ボタンの中など、隣の「完了数/総数」の文字が進み具合を伝える場所で使う） */
  label: string | undefined;
}>();

const width = computed(() =>
  props.total === 0 ? "0%" : `${Math.round((props.completed / props.total) * 100)}%`,
);
const done = computed(() => props.total > 0 && props.completed === props.total);

/** 名前があるときだけ progressbar として読ませる */
const a11y = computed(() =>
  props.label === undefined
    ? { "aria-hidden": "true" as const }
    : {
        role: "progressbar",
        "aria-label": props.label,
        "aria-valuemin": 0,
        "aria-valuenow": props.completed,
        "aria-valuemax": props.total,
      },
);
</script>

<template>
  <div class="h-1 w-full overflow-hidden rounded-full bg-element" v-bind="a11y">
    <div
      class="h-full rounded-full transition-[width]"
      :class="done ? 'bg-success' : 'bg-primary'"
      :style="{ width }"
    />
  </div>
</template>
