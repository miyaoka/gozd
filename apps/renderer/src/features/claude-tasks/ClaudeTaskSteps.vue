<script setup lang="ts">
import type { FunctionalComponent, SVGAttributes } from "vue";
import { computed } from "vue";
import ClaudeTaskProgressBar from "./ClaudeTaskProgressBar.vue";
import { type ClaudeTaskList, completedCount, isBlocked, taskListHeadline } from "./claudeTaskList";
import IconLucideCircle from "~icons/lucide/circle";
import IconLucideCircleCheck from "~icons/lucide/circle-check";
import IconLucideCircleDashed from "~icons/lucide/circle-dashed";
import IconLucideCircleDot from "~icons/lucide/circle-dot";

type StepKind = "completed" | "in_progress" | "blocked" | "pending";

const STEP_VISUAL: Record<
  StepKind,
  { icon: FunctionalComponent<SVGAttributes>; iconClass: string; textClass: string; label: string }
> = {
  completed: {
    icon: IconLucideCircleCheck,
    iconClass: "text-success-text",
    textClass: "text-foreground-muted line-through",
    label: "Completed",
  },
  in_progress: {
    icon: IconLucideCircleDot,
    iconClass: "text-primary-text",
    textClass: "text-foreground font-semibold",
    label: "In progress",
  },
  blocked: {
    icon: IconLucideCircleDashed,
    iconClass: "text-foreground-muted",
    textClass: "text-foreground-low",
    label: "Blocked",
  },
  pending: {
    icon: IconLucideCircle,
    iconClass: "text-foreground-muted",
    textClass: "text-foreground-low",
    label: "Pending",
  },
};

const props = defineProps<{
  list: ClaudeTaskList;
}>();

const completed = computed(() => completedCount(props.list));
const progressLabel = computed(() => {
  const headline = taskListHeadline(props.list);
  return headline === "" ? "Task progress" : `Progress: ${headline}`;
});

const steps = computed(() =>
  props.list.tasks.map((task) => {
    const kind: StepKind =
      task.status === "pending" && isBlocked(task, props.list.tasks) ? "blocked" : task.status;
    const visual = STEP_VISUAL[kind];
    const text =
      task.status === "in_progress" && task.activeForm !== "" ? task.activeForm : task.subject;
    const title = [`${visual.label}: ${task.subject}`, task.description]
      .filter((line) => line !== "")
      .join("\n");
    return { id: task.id, text, title, ...visual };
  }),
);
</script>

<template>
  <section class="flex flex-col gap-2 rounded-sm border border-border-subtle bg-panel p-2">
    <h3 v-if="list.goal" class="text-xs font-semibold wrap-break-word text-foreground">
      {{ list.goal }}
    </h3>
    <div class="flex items-center gap-2 text-xs text-foreground-low">
      <ClaudeTaskProgressBar
        :completed="completed"
        :total="list.tasks.length"
        :label="progressLabel"
      />
      <span class="shrink-0 tabular-nums">{{ completed }}/{{ list.tasks.length }}</span>
    </div>
    <ol class="flex flex-col gap-0.5">
      <li
        v-for="step in steps"
        :key="step.id"
        class="flex items-start gap-1.5 px-1 py-0.5 text-xs"
        :title="step.title"
      >
        <component :is="step.icon" class="size-3.5 shrink-0" :class="step.iconClass" />
        <span class="min-w-0 wrap-break-word" :class="step.textClass">{{ step.text }}</span>
      </li>
    </ol>
  </section>
</template>
