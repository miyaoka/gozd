<script setup lang="ts">
import { computed } from "vue";

/** 装飾として読み上げから外す。進み具合は隣の「完了数/総数」の文字が伝える */
const props = defineProps<{
  completed: number;
  total: number;
}>();

const width = computed(() =>
  props.total === 0 ? "0%" : `${Math.round((props.completed / props.total) * 100)}%`,
);
const done = computed(() => props.total > 0 && props.completed === props.total);
</script>

<template>
  <div class="h-1 w-full overflow-hidden rounded-full bg-element" aria-hidden="true">
    <div
      class="h-full rounded-full transition-[width]"
      :class="done ? 'bg-success' : 'bg-primary'"
      :style="{ width }"
    />
  </div>
</template>
