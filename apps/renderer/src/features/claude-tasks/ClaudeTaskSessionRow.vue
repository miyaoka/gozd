<script setup lang="ts">
import { computed } from "vue";
import { claudeStateGlyph, type LiveSession } from "../terminal";
import ClaudeTaskProgressBar from "./ClaudeTaskProgressBar.vue";
import { type ClaudeTaskList, completedCount, taskListHeadline } from "./claudeTaskList";

const props = defineProps<{
  session: LiveSession;
  list: ClaudeTaskList;
}>();

const emit = defineEmits<{
  select: [];
}>();

const state = computed(() => claudeStateGlyph(props.session.status));

const headline = computed(() => taskListHeadline(props.list) || props.session.terminalTitle);
/** 見出しが目的や手順のときだけ、どのセッションかをセッションのタイトルで添える */
const subtitle = computed(() =>
  headline.value === props.session.terminalTitle ? "" : props.session.terminalTitle,
);
const completed = computed(() => completedCount(props.list));
</script>

<template>
  <button
    type="button"
    class="flex w-full flex-col gap-1 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-element-hover"
    :title="subtitle ? `${headline}\n${subtitle}` : headline"
    @click="emit('select')"
  >
    <span class="flex w-full items-center gap-1.5">
      <component
        :is="state.icon"
        class="size-3.5 shrink-0"
        :class="state.class"
        role="img"
        :aria-label="state.ariaLabel"
      />
      <span class="min-w-0 flex-1 truncate text-foreground">{{ headline }}</span>
      <span class="shrink-0 text-foreground-low tabular-nums"
        >{{ completed }}/{{ list.tasks.length }}</span
      >
    </span>
    <span v-if="subtitle" class="w-full truncate text-foreground-low">{{ subtitle }}</span>
    <ClaudeTaskProgressBar :completed="completed" :total="list.tasks.length" />
  </button>
</template>
