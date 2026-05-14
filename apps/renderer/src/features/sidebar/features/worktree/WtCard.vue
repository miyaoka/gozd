<doc lang="md">
1 worktree のカード。ヘッダ (branch icon / branch / git status / resumable count / ⋮) と、
session 由来の Task 行 (TaskRow) を縦に並べる。task が無い wt はヘッダのみ。

## ハイライト

active wt の場合、wt ヘッダには常に capsule fill。さらに focused PTY が task
(= session) なら該当 task 行にも capsule。wt と task の両方が同時にハイライト
されることで「どの wt のどの task に focus があるか」が一目で識別できる。

## 並び順

task は `task.createdAt` 昇順 (append 順) で固定。新しい task は末尾に追加され、
既存 task の位置は動かない。state や lastActivityAt は動的なためソートキーに
混ぜない。位置の安定性を優先し、状態は行頭アイコンと相対時刻表示で示す責務
分担。wt の並び (`RepoSection.orderedWorktrees` の `git worktree list` append 順)
と同じ方針。
</doc>

<script setup lang="ts">
import type { Task, WorktreeEntry } from "@gozd/proto";
import { computed } from "vue";
import type { ClaudeStatus } from "../../../terminal";
import { useTerminalStore } from "../../../terminal";
import { computeStatusIcons, StatusIcons } from "../../../worktree";
import { branchLabel as resolveBranchLabel, hasChanges } from "../../utils";
import TaskRow from "./TaskRow.vue";

const props = defineProps<{
  wt: WorktreeEntry;
  rootDir: string;
  active: boolean;
  focusedPtyId: number | undefined;
  resumeableSessionCount: number;
}>();

const emit = defineEmits<{
  selectWt: [wt: WorktreeEntry];
  selectTask: [wt: WorktreeEntry, task: Task];
  openMenu: [anchorEl: HTMLElement, wt: WorktreeEntry];
}>();

const terminalStore = useTerminalStore();

const branchIcon = computed(() =>
  props.wt.isMain ? "icon-[lucide--house]" : "icon-[lucide--git-branch]",
);
const branchLabel = computed(() => resolveBranchLabel(props.wt.branch));

const statusIcons = computed(() => {
  if (!props.wt.gitStatuses) return [];
  return computeStatusIcons(props.wt.gitStatuses);
});

interface TaskWithStatus {
  task: Task;
  status: ClaudeStatus | undefined;
  ptyId: number | undefined;
}

/**
 * ソートは `task.createdAt` (静的) のみ。state や lastActivityAt のような
 * 動的値をキーに混ぜると Claude の活動ごとに行位置が入れ替わり、ユーザーが
 * 「どこに何の task があるか」を空間記憶で辿れなくなる。位置は固定、状態は
 * 行頭アイコンと相対時刻で表現する責務分担。
 */
const tasksWithStatus = computed<TaskWithStatus[]>(() => {
  const list = props.wt.tasks.map<TaskWithStatus>((task) => ({
    task,
    status: terminalStore.getClaudeStatusBySessionId(task.id),
    ptyId: terminalStore.getPtyIdBySessionId(task.id),
  }));
  return list.sort((a, b) => Date.parse(a.task.createdAt) - Date.parse(b.task.createdAt));
});

/**
 * wt 内のいずれかの task が focused PTY を持っているか。
 * active wt 以外では capsule を出してはいけない。各 wt の layoutsByDir[dir].
 * focusedLeafId は履歴として残るため、active 条件を噛ませないと過去訪問した
 * 全 wt で task に capsule が点いてしまう。
 */
const focusedTaskId = computed(() => {
  if (!props.active) return undefined;
  const focusedPty = props.focusedPtyId;
  if (focusedPty === undefined) return undefined;
  const found = tasksWithStatus.value.find((entry) => entry.ptyId === focusedPty);
  return found?.task.id;
});

/** focus が wt 内にあるなら header に capsule (task focus 時も同時にハイライト) */
const headerActive = computed(() => props.active);

function onMenuClick(event: MouseEvent) {
  event.stopPropagation();
  const target = event.currentTarget;
  if (target instanceof HTMLElement) emit("openMenu", target, props.wt);
}

function onHeaderClick() {
  emit("selectWt", props.wt);
}
</script>

<template>
  <article class="rounded-lg">
    <div class="group/wt relative">
      <div
        role="button"
        tabindex="0"
        :data-active="headerActive"
        class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-zinc-400 transition-colors hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none focus-visible:ring-inset data-[active=true]:bg-blue-500 data-[active=true]:text-white"
        @click="onHeaderClick"
        @keydown.enter.prevent="onHeaderClick"
        @keydown.space.prevent="onHeaderClick"
      >
        <span class="grid size-5 shrink-0 place-items-center" aria-hidden="true">
          <span class="size-3.5" :class="branchIcon" />
        </span>
        <span class="flex-1 truncate text-left text-xs font-medium">{{ branchLabel }}</span>
        <span
          v-if="wt.gitStatuses && hasChanges(wt.gitStatuses)"
          class="flex items-center justify-end gap-1 text-xs"
        >
          <StatusIcons :entries="statusIcons" />
        </span>
        <span
          v-if="resumeableSessionCount > 0"
          class="flex items-center gap-1 text-[10px] text-zinc-400"
          :title="`${resumeableSessionCount} resumable session${resumeableSessionCount === 1 ? '' : 's'}`"
        >
          <span class="icon-[lucide--rotate-cw] size-3" />
          <span class="tabular-nums">{{ resumeableSessionCount }}</span>
        </span>
      </div>
      <button
        type="button"
        aria-label="Open menu"
        class="absolute top-1/2 right-1 grid size-5 -translate-y-1/2 place-items-center rounded-sm bg-zinc-800 text-zinc-300 opacity-0 shadow-md ring-1 ring-zinc-700 transition-opacity duration-100 group-focus-within/wt:opacity-100 group-hover/wt:opacity-100 hover:bg-zinc-700 hover:text-zinc-100"
        @click="onMenuClick"
      >
        <span class="icon-[lucide--ellipsis-vertical] text-xs" />
      </button>
    </div>

    <div v-if="tasksWithStatus.length > 0">
      <TaskRow
        v-for="entry in tasksWithStatus"
        :key="entry.task.id"
        :task="entry.task"
        :status="entry.status"
        :active="focusedTaskId === entry.task.id"
        @select="(t) => emit('selectTask', wt, t)"
      />
    </div>
  </article>
</template>
