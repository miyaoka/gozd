<doc lang="md">
commit 行の右クリック / ⋮ ボタンから開くコンテキストメニュー。
state は `useCommitMenu` (module singleton) 経由で GitGraphPane と共有する。
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { computed } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { rpcGitReset } from "./rpc";
import { useCommitMenu } from "./useCommitMenu";

const { Popover, context, close } = useCommitMenu();
const notify = useNotificationStore();

// 右クリックでマウス座標 (context.x/y) が渡された場合はそれを優先。
// ⋮ ボタン経路など座標未指定の場合は CSS Anchor Position で anchor 要素の bottom-left に出す。
const popoverStyle = computed(() => {
  const ctx = context.value;
  if (ctx?.x !== undefined && ctx?.y !== undefined) {
    return { position: "fixed", left: `${ctx.x}px`, top: `${ctx.y}px` };
  }
  return {
    position: "fixed",
    top: "anchor(bottom)",
    left: "anchor(left)",
    positionTryFallbacks: "flip-block, flip-inline",
  };
});

// reset 後の HEAD 移動は FSEvents → gitStatusChange push で git-graph が自動再描画されるため、
// caller 側で明示的な再 fetch は不要 (SSOT push 規律)。
async function handleReset() {
  const ctx = context.value;
  if (!ctx) return;
  close();
  const result = await tryCatch(rpcGitReset({ dir: ctx.dir, hash: ctx.commit.hash }));
  if (!result.ok) {
    notify.error("Failed to reset to commit", result.error);
  }
}
</script>

<template>
  <Popover
    class="m-0 min-w-44 rounded-lg border border-zinc-700 bg-zinc-900 py-1 text-sm text-zinc-200 shadow-lg"
    :style="popoverStyle"
  >
    <div
      v-if="context"
      class="border-b border-zinc-800 px-3 py-1 font-mono text-[10px] text-zinc-500"
    >
      {{ context.commit.shortHash }}
    </div>
    <button
      v-if="context"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800"
      title="git reset (mixed): move HEAD and reset index, keep working tree"
      @click="handleReset"
    >
      <span class="icon-[lucide--undo-2] text-xs" />
      Reset to this commit
    </button>
  </Popover>
</template>
