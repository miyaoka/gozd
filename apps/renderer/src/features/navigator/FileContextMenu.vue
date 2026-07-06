<doc lang="md">
ファイル行の右クリックメニュー。Copy file（ファイル参照の OS クリップボード書き込み）と
Copy path（テキスト）を描画する。context の組み立てと snapshot semantics、
defer / disconnect ガード等の内部仕様は `useFileContextMenu.ts` の docstring を SSOT として参照する。

Copy file は snapshot mode（context.isSnapshot）では項目ごと出さない。snapshot のファイルは
ディスク上に実体が無く、パスを載せると最新の worktree 内容が paste される誤読を生むため。
メニューは可視 UI なので「出さない」こと自体が説明になり、toast による拒否通知
（キーボード経路 `filer.copyFile` の担当）は不要。
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { computed } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { copyFileToOsClipboard } from "../filer";
import { joinAbsRel } from "../worktree";
import { useFileContextMenu } from "./useFileContextMenu";
import IconLucideFiles from "~icons/lucide/files";
import IconLucideFolderTree from "~icons/lucide/folder-tree";

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
    positionArea: "block-end span-inline-end",
    positionTryFallbacks: "flip-block, flip-inline, flip-block flip-inline",
  };
});

async function handleCopyFile() {
  if (!context.value) return;
  const { dir, relPath } = context.value;
  close();
  await copyFileToOsClipboard(joinAbsRel(dir, relPath), relPath);
}

async function handleCopyPath() {
  if (!context.value) return;
  const { dir, relPath, commitHash } = context.value;
  const absPath = joinAbsRel(dir, relPath);
  const text = commitHash === undefined ? absPath : `${commitHash}\n${absPath}`;
  close();
  // navigator.clipboard 参照時の同期 throw も拾うため async IIFE で Promise 化してから tryCatch に渡す
  const result = await tryCatch((async () => navigator.clipboard.writeText(text))());
  if (!result.ok) {
    notify.error("Failed to copy path", result.error);
  }
}
</script>

<template>
  <Popover
    class="m-0 min-w-36 rounded-lg border border-border bg-background py-1 text-sm text-foreground shadow-lg"
    :style="popoverStyle"
  >
    <button
      v-if="context && !context.isSnapshot"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel"
      @click="handleCopyFile"
    >
      <IconLucideFiles class="size-4 shrink-0" />
      Copy file
    </button>
    <button
      v-if="context"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel"
      @click="handleCopyPath"
    >
      <IconLucideFolderTree class="size-4 shrink-0" />
      Copy path
    </button>
  </Popover>
</template>
