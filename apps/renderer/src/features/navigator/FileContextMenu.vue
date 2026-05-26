<doc lang="md">
ファイル行の右クリックメニュー。Copy file path アクションを表示する。

copy する path は context に焼き付けられた `dir` (右クリック時の snapshot) と `relPath` を
`joinAbsRel` で結合した絶対パス。defer 中 / menu 表示中に worktree が切り替わっても、その
右クリック時点の dir / commitHash を一貫して使う (singleton store を読み直さない)。

- working tree のファイル (commitHash 未指定): 絶対パスのみを copy
- snapshot / commit 由来 (commitHash 指定): `${commitHash}\n${絶対パス}` を copy

state は `useFileContextMenu` (module singleton) 経由で開閉する。
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { computed } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { joinAbsRel } from "../worktree";
import { useFileContextMenu } from "./useFileContextMenu";

const { Popover, context, close } = useFileContextMenu();
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

async function handleCopyPath() {
  if (!context.value) return;
  const { dir, relPath, commitHash } = context.value;
  const absPath = joinAbsRel(dir, relPath);
  const text = commitHash === undefined ? absPath : `${commitHash}\n${absPath}`;
  close();
  // navigator.clipboard 参照時の同期 throw も拾うため async IIFE で Promise 化してから tryCatch に渡す
  const result = await tryCatch((async () => navigator.clipboard.writeText(text))());
  if (!result.ok) {
    notify.error("Failed to copy file path", result.error);
  }
}
</script>

<template>
  <Popover
    class="m-0 min-w-36 rounded-lg border border-zinc-700 bg-zinc-900 py-1 text-sm text-zinc-200 shadow-lg"
    :style="popoverStyle"
  >
    <button
      v-if="context"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800"
      @click="handleCopyPath"
    >
      <span class="icon-[lucide--copy] text-xs" />
      Copy file path
    </button>
  </Popover>
</template>
