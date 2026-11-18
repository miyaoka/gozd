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
  <!-- 行のどこを押しても選ぶ。ボタンはフォーカスとキー操作の受け口で、その click も
       ここへ伝わって 1 回だけ選ぶ（button の中に手順の ol は置けない） -->
  <section
    class="flex cursor-pointer flex-col rounded-sm border transition-colors hover:bg-element-hover"
    :class="focused ? 'border-border-subtle bg-panel' : 'border-transparent'"
    @click="emit('select')"
  >
    <button
      type="button"
      class="flex w-full flex-col gap-1 rounded-sm px-2 py-1.5 text-left text-xs"
      :aria-current="focused ? 'true' : undefined"
    >
      <span class="flex w-full items-start gap-1.5">
        <component
          :is="state.icon"
          class="mt-px size-3.5 shrink-0"
          :class="state.class"
          role="img"
          :aria-label="state.ariaLabel"
        />
        <span class="min-w-0 flex-1 wrap-break-word text-foreground">{{ headline }}</span>
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
