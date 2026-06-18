<doc lang="md">
task 行の ⋮ ポップオーバーメニュー。Edit title / Show session log / Remove task を表示する。
state は `useTaskMenu` (module singleton) 経由で SidebarPane と共有する。
Edit title は `useTaskEditing.open` 経由で TaskEditDialog を開く。
Show session log は `task.sessionId` が非空のときだけ出し、`useSessionLogViewer.open` 経由で
SessionLogDialog を開く (session 未起動の task では Claude ログが存在しないため非表示)。
</doc>

<script setup lang="ts">
import type { Task } from "@gozd/proto";
import { computed } from "vue";
import { taskDisplayTitle } from "../../shared/repo";
import { useSessionLogViewer } from "../session-log";
import { useTaskEditing } from "./useTaskEditing";
import { useTaskMenu } from "./useTaskMenu";
import IconLucidePencil from "~icons/lucide/pencil";
import IconLucideScrollText from "~icons/lucide/scroll-text";
import IconLucideTrash2 from "~icons/lucide/trash-2";

const emit = defineEmits<{
  remove: [task: Task, rootDir: string];
}>();

const { Popover, context, close } = useTaskMenu();
const { open: openEdit } = useTaskEditing();
const { open: openSessionLog } = useSessionLogViewer();

// session 未起動 (sessionId 空) の task は Claude ログファイルが存在しないため非表示。
const hasSessionLog = computed(() => context.value?.task.sessionId !== "");

function handleEdit() {
  if (!context.value) return;
  const { task, rootDir } = context.value;
  close();
  openEdit(task.id, rootDir);
}

function handleShowSessionLog() {
  if (!context.value) return;
  const { task } = context.value;
  close();
  openSessionLog(task.sessionId, taskDisplayTitle(task));
}

function handleRemove() {
  if (!context.value) return;
  const { task, rootDir } = context.value;
  close();
  emit("remove", task, rootDir);
}
</script>

<template>
  <Popover
    class="m-0 min-w-36 rounded-lg border border-border bg-background py-1 text-sm text-foreground shadow-lg"
    :style="{
      position: 'fixed',
      positionArea: 'block-end span-inline-end',
      positionTryFallbacks: 'flip-block, flip-inline, flip-block flip-inline',
    }"
  >
    <template v-if="context">
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel"
        @click="handleEdit"
      >
        <IconLucidePencil class="text-xs" />
        Edit title
      </button>
      <button
        v-if="hasSessionLog"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel"
        @click="handleShowSessionLog"
      >
        <IconLucideScrollText class="text-xs" />
        Show session log
      </button>
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-destructive-text hover:bg-panel"
        @click="handleRemove"
      >
        <IconLucideTrash2 class="text-xs" />
        Remove task
      </button>
    </template>
  </Popover>
</template>
