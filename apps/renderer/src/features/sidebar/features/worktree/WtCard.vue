<doc lang="md">
1 worktree のカード。ヘッダ (branch icon / branch / git status / terminal count / ⋮) と、
session 由来の Task 行 (TaskRow) を縦に並べる。task が無い wt はヘッダのみ。

## ハイライトの二者択一

ヘッダと task 行のうち capsule fill が当たるのはどちらか一方:

- focused PTY が task (= session) なら → 該当 task 行に capsule
- focused PTY が shell なら → wt ヘッダに capsule

両方同時には付かない。

## 並び順

task 内: state 優先順 (asking > working > done > idle > resumable)、同 state 内は時刻新しい順。
</doc>

<script setup lang="ts">
import type { Task, WorktreeEntry } from "@gozd/proto";
import { computed } from "vue";
import type { ClaudeStatus } from "../../../terminal";
import { useTerminalStore } from "../../../terminal";
import { computeStatusIcons, StatusIcons } from "../../../worktree";
import { branchLabel as resolveBranchLabel, hasChanges } from "../../utils";
import TaskRow from "./TaskRow.vue";

type StateKey = "asking" | "working" | "done" | "idle" | "resumable";
const STATE_PRIORITY: Record<StateKey, number> = {
  asking: 4,
  working: 3,
  done: 2,
  idle: 1,
  resumable: 0,
};

const props = defineProps<{
  wt: WorktreeEntry;
  rootDir: string;
  active: boolean;
  focusedPtyId: number | undefined;
  terminalCount: number;
  resumeableSessionCount: number;
  now: number;
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
  stateKey: StateKey;
  baseTime: number;
}

/**
 * status が undefined になるケースは 2 つあり、ptyId の有無で区別する。
 * - ptyId が紐付いている: live PTY はあるが session-start hook の status 反映が
 *   間に合っていない一瞬の窓 → idle 相当として扱う (resumable に倒すと UI 上で
 *   起動中 session が灰色アイコンに化けて UX が崩れる)
 * - ptyId が無い: 永続化された session のみで live PTY 不在 → 真の resumable
 */
function resolveStateKey(status: ClaudeStatus | undefined, ptyId: number | undefined): StateKey {
  if (status !== undefined) return status.state;
  if (ptyId === undefined) return "resumable";
  return "idle";
}

function resolveBaseTime(status: ClaudeStatus | undefined, fallback: number): number {
  if (status === undefined) return fallback;
  if (status.state === "working") return status.lastActivityAt;
  return status.enteredAt;
}

const tasksWithStatus = computed<TaskWithStatus[]>(() => {
  const list = props.wt.tasks.map<TaskWithStatus>((task) => {
    const status = terminalStore.getClaudeStatusBySessionId(task.id);
    const ptyId = terminalStore.getPtyIdBySessionId(task.id);
    const fallback = Date.parse(task.createdAt);
    return {
      task,
      status,
      ptyId,
      stateKey: resolveStateKey(status, ptyId),
      baseTime: resolveBaseTime(status, Number.isNaN(fallback) ? 0 : fallback),
    };
  });
  return list.sort((a, b) => {
    const diff = STATE_PRIORITY[b.stateKey] - STATE_PRIORITY[a.stateKey];
    if (diff !== 0) return diff;
    return b.baseTime - a.baseTime;
  });
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

/** focus が wt 内にあり、かつ task でない (= shell) なら header に capsule */
const headerActive = computed(() => props.active && focusedTaskId.value === undefined);

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
    <div
      role="button"
      tabindex="0"
      :data-active="headerActive"
      class="group/wt grid w-full cursor-pointer grid-cols-[auto_1fr_auto_auto_auto] items-center gap-2 rounded-lg px-3 py-2 transition-colors hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none focus-visible:ring-inset data-[active=true]:bg-blue-500 data-[active=true]:text-white"
      @click="onHeaderClick"
      @keydown.enter.prevent="onHeaderClick"
      @keydown.space.prevent="onHeaderClick"
    >
      <span class="size-5 shrink-0" :class="branchIcon" aria-hidden="true" />
      <span class="truncate text-left text-sm font-medium">{{ branchLabel }}</span>
      <span
        v-if="wt.gitStatuses && hasChanges(wt.gitStatuses)"
        class="flex items-center gap-1 text-xs"
      >
        <StatusIcons :entries="statusIcons" />
      </span>
      <span
        v-if="terminalCount >= 2"
        class="grid size-4 min-w-4 place-items-center rounded-full bg-zinc-700 px-1 text-[10px] font-medium text-zinc-200 tabular-nums"
        :title="`${terminalCount} terminals`"
      >
        {{ terminalCount }}
      </span>
      <span
        v-else-if="resumeableSessionCount > 0"
        class="flex items-center gap-1 text-[10px] text-zinc-400"
        :title="`${resumeableSessionCount} resumable session${resumeableSessionCount === 1 ? '' : 's'}`"
      >
        <span class="icon-[lucide--rotate-cw] size-3" />
        <span class="tabular-nums">{{ resumeableSessionCount }}</span>
      </span>
      <button
        type="button"
        aria-label="Open menu"
        class="grid size-6 place-items-center rounded-sm text-zinc-400 opacity-0 transition-opacity duration-100 group-focus-within/wt:opacity-100 group-hover/wt:opacity-100 hover:bg-white/10 hover:text-zinc-100"
        @click="onMenuClick"
      >
        <span class="icon-[lucide--ellipsis-vertical] text-sm" />
      </button>
    </div>

    <div v-if="tasksWithStatus.length > 0" class="p-1">
      <TaskRow
        v-for="entry in tasksWithStatus"
        :key="entry.task.id"
        :task="entry.task"
        :status="entry.status"
        :active="focusedTaskId === entry.task.id"
        :now="now"
        @select="(t) => emit('selectTask', wt, t)"
      />
    </div>
  </article>
</template>
