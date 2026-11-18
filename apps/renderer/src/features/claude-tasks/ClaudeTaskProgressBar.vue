<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  completed: number;
  total: number;
  /** どの一覧の進み具合かを読み上げで区別する名前 */
  label: string;
}>();

const width = computed(() =>
  props.total === 0 ? "0%" : `${Math.round((props.completed / props.total) * 100)}%`,
);
const done = computed(() => props.total > 0 && props.completed === props.total);
</script>

<template>
  <div
    class="h-1 w-full overflow-hidden rounded-full bg-element"
    role="progressbar"
    :aria-label="label"
    aria-valuemin="0"
    :aria-valuenow="completed"
    :aria-valuemax="total"
  >
    <div
      class="h-full rounded-full transition-[width]"
      :class="done ? 'bg-success' : 'bg-primary'"
      :style="{ width }"
    />
  </div>
</template>
