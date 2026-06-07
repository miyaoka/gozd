<doc lang="md">
git-graph の commit 行の右クリックメニュー。「Reset (mixed) to here」アクションを描画し、
snapshot した dir / hash に対して `git reset --mixed` を実行する。context の組み立てと
snapshot semantics、defer / disconnect ガード等の内部仕様は `useCommitContextMenu.ts` の
docstring を SSOT として参照する。
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { computed } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { rpcGitResetMixed } from "./rpc";
import { useCommitContextMenu } from "./useCommitContextMenu";

const { Popover, context, close } = useCommitContextMenu();
const notify = useNotificationStore();

// 右クリックでマウス座標 (context.x/y) が渡された場合はそれを優先。
// 座標未指定の経路では CSS Anchor Position で anchor 要素の bottom-left に出す。
const popoverStyle = computed(() => {
  const ctx = context.value;
  if (ctx?.x !== undefined && ctx?.y !== undefined) {
    return { position: "fixed", left: `${ctx.x}px`, top: `${ctx.y}px` };
  }
  return {
    position: "fixed",
    positionArea: "block-end span-inline-end",
    positionTryFallbacks: "flip-block, flip-inline, flip-block flip-inline",
  };
});

/** メニュー表示用の短縮 hash (7 桁)。full hash は RPC にそのまま渡す */
const shortHash = computed(() => context.value?.hash.slice(0, 7) ?? "");

async function handleResetMixed() {
  if (!context.value) return;
  const { dir, hash } = context.value;
  close();
  const result = await tryCatch(rpcGitResetMixed({ dir, hash }));
  if (!result.ok) {
    notify.error("Failed to reset", result.error);
  }
}
</script>

<template>
  <Popover
    class="m-0 min-w-44 rounded-lg border border-zinc-700 bg-zinc-900 py-1 text-sm text-zinc-200 shadow-lg"
    :style="popoverStyle"
  >
    <button
      v-if="context"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800"
      @click="handleResetMixed"
    >
      <span class="icon-[lucide--undo-2] text-xs" />
      Reset (mixed) to <span class="font-mono text-zinc-400">{{ shortHash }}</span>
    </button>
  </Popover>
</template>
