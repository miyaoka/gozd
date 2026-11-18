<script setup lang="ts">
import { computed } from "vue";
import { claudeStateGlyph, type LiveSession } from "../terminal";
import ClaudeTaskProgressBar from "./ClaudeTaskProgressBar.vue";
import ClaudeTaskSteps from "./ClaudeTaskSteps.vue";
import { type ClaudeTaskList, completedCount, taskListHeadline } from "./claudeTaskList";

const props = defineProps<{
  session: LiveSession;
  list: ClaudeTaskList;
  /** フォーカス中のセッション。枠で囲んで見分ける */
  focused: boolean;
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
  <section
    class="flex flex-col rounded-sm border"
    :class="focused ? 'border-border-subtle bg-panel' : 'border-transparent'"
  >
    <button
      type="button"
      class="flex w-full flex-col gap-1 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-element-hover"
      :aria-current="focused ? 'true' : undefined"
      @click="emit('select')"
    >
      <span class="flex w-full items-start gap-1.5">
        <component
          :is="state.icon"
          class="mt-px size-3.5 shrink-0"
          :class="state.class"
          role="img"
          :aria-label="state.ariaLabel"
        />
        <span
          class="min-w-0 flex-1 wrap-break-word text-foreground"
          :class="{ 'font-semibold': focused }"
          >{{ headline }}</span
        >
        <span class="shrink-0 text-foreground-low tabular-nums"
          >{{ completed }}/{{ list.tasks.length }}</span
        >
      </span>
      <span v-if="subtitle" class="w-full wrap-break-word text-foreground-low">{{ subtitle }}</span>
      <ClaudeTaskProgressBar :completed="completed" :total="list.tasks.length" />
    </button>
    <ClaudeTaskSteps :list="list" class="px-1 pb-1.5" />
  </section>
</template>
