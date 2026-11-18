<script setup lang="ts">
import { computed } from "vue";

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
  <div
    class="h-1 w-full overflow-hidden rounded-full bg-element"
    role="progressbar"
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
