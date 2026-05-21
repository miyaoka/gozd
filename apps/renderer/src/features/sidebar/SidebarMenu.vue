<doc lang="md">
共有 ⋮ ポップオーバーメニュー。

worktree カード / task 行から呼ばれ、コンテキストに応じたアクション (Remove worktree /
Remove task) を表示する。親が `openState` を set すると `anchorEl` の直下に popover を
開き、popover が閉じたら `close` を emit する。
</doc>

<script setup lang="ts">
import type { Task, WorktreeEntry } from "@gozd/proto";
import { computed, nextTick, ref, watch } from "vue";

type MenuContext =
  | { type: "worktree"; worktree: WorktreeEntry; rootDir: string }
  | { type: "task"; task: Task; rootDir: string };

interface OpenState {
  anchorEl: HTMLElement;
  context: MenuContext;
}

const props = defineProps<{
  openState?: OpenState;
}>();

const emit = defineEmits<{
  worktreeRemove: [wt: WorktreeEntry, rootDir: string];
  taskRemove: [task: Task, rootDir: string];
  close: [];
}>();

/**
 * showPopover に渡す `source` 引数の型。
 * Popover API の最新仕様（HTMLElement.showPopover(options)）。
 * lib.dom.d.ts への取り込みが追いついていないため最小宣言を持つ。
 */
type ShowPopoverOptions = { source?: HTMLElement };
type PopoverElement = HTMLElement & { showPopover(options?: ShowPopoverOptions): void };

const menuRef = ref<PopoverElement>();
const menuContext = computed(() => props.openState?.context);

// アクション click / light-dismiss どちらも @toggle 経由で `close` emit に集約する。
// 一方、新しい anchor に切り替えるための「自前 hide → show」経路では close emit を
// 親に伝えると openState が clear されて showPopover 直後に content が空になるため、
// この経路でのみ次の @toggle "closed" を skip する。
let suppressNextCloseEmit = false;

// openState がセットされた時点で popover を開く。
// 既に open 中（keyboard / 外側 click 抑止などで light-dismiss が走らなかった
// 場合の anchor 切り替え経路）は spec 上 showPopover を再度呼ぶと
// InvalidStateError になるため、明示的に hidePopover → showPopover の順序で
// anchor を付け替える。
watch(
  () => props.openState,
  async (state) => {
    if (!state) return;
    await nextTick();
    const el = menuRef.value;
    if (!el) return;
    if (el.matches(":popover-open")) {
      suppressNextCloseEmit = true;
      el.hidePopover();
    }
    el.showPopover({ source: state.anchorEl });
  },
);

function handleWorktreeRemove(wt: WorktreeEntry, rootDir: string) {
  menuRef.value?.hidePopover();
  emit("worktreeRemove", wt, rootDir);
}

function handleTaskRemove(task: Task, rootDir: string) {
  menuRef.value?.hidePopover();
  emit("taskRemove", task, rootDir);
}

// popover が閉じた瞬間に親へ通知 (light-dismiss / hidePopover どちらも経由する)。
// 自前 hide → show の中間 hide は suppressNextCloseEmit で skip する。
function onToggle(event: ToggleEvent) {
  if (event.newState !== "closed") return;
  if (suppressNextCloseEmit) {
    suppressNextCloseEmit = false;
    return;
  }
  emit("close");
}
</script>

<template>
  <div
    ref="menuRef"
    popover="auto"
    class="m-0 min-w-36 rounded-lg border border-zinc-700 bg-zinc-900 py-1 text-sm text-zinc-200 shadow-lg"
    :style="{
      top: 'anchor(bottom)',
      left: 'anchor(left)',
    }"
    @toggle="onToggle"
  >
    <template v-if="menuContext?.type === 'worktree' && menuContext.worktree">
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-400 hover:bg-zinc-800"
        @click="handleWorktreeRemove(menuContext.worktree, menuContext.rootDir)"
      >
        <span class="icon-[lucide--unlink] text-xs" />
        Remove worktree
      </button>
    </template>
    <template v-else-if="menuContext?.type === 'task' && menuContext.task">
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-400 hover:bg-zinc-800"
        @click="handleTaskRemove(menuContext.task, menuContext.rootDir)"
      >
        <span class="icon-[lucide--trash-2] text-xs" />
        Remove task
      </button>
    </template>
  </div>
</template>

<style scoped>
[popover] {
  position: fixed;
  position-try-fallbacks: flip-block, flip-inline;
}
</style>
