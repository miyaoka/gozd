<script setup lang="ts">
import { computed } from "vue";
import { toolArgPreview } from "./sessionLogToolArg";

const props = defineProps<{
  input: Record<string, unknown>;
}>();

const preview = computed(() => toolArgPreview(props.input));
</script>

<template>
  <span v-if="preview" class="min-w-0 truncate text-foreground-low" :title="preview.full">{{
    preview.label
  }}</span>
</template>
