<script setup lang="ts">
import type { FunctionalComponent, SVGAttributes } from "vue";
import { computed } from "vue";
import { type ClaudeTaskList, isBlocked, openTaskIds } from "./claudeTaskList";
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

const steps = computed(() => {
  const openIds = openTaskIds(props.list.tasks);
  return props.list.tasks.map((task) => {
    const kind: StepKind =
      task.status === "pending" && isBlocked(task, openIds) ? "blocked" : task.status;
    const visual = STEP_VISUAL[kind];
    const text =
      task.status === "in_progress" && task.activeForm !== "" ? task.activeForm : task.subject;
    return { id: task.id, text, ...visual };
  });
});
</script>

<template>
  <ol class="flex flex-col gap-0.5">
    <li v-for="step in steps" :key="step.id" class="flex items-start gap-1.5 px-1 py-0.5 text-xs">
      <component
        :is="step.icon"
        class="mt-px size-3.5 shrink-0"
        :class="step.iconClass"
        role="img"
        :aria-label="step.label"
      />
      <span class="min-w-0 wrap-break-word" :class="step.textClass">{{ step.text }}</span>
    </li>
  </ol>
</template>
