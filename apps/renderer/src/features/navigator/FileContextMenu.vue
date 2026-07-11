<doc lang="md">
ファイル行の右クリックメニュー。項目 (Open in default app / Copy file / Copy path) は
preview ヘッダの ⋮ メニューと共通の `FileActionMenuItems` (filer) を描画する。
context の組み立てと snapshot semantics、defer / disconnect ガード等の内部仕様は
`useFileContextMenu.ts` の docstring を SSOT として参照する。

Open / Copy file は snapshot mode (context.isSnapshot) では出さない。可視判定の理由は
FileActionMenuItems の doc を参照 (openable prop に反転して渡す)。
</doc>

<script setup lang="ts">
import { computed } from "vue";
import { FileActionMenuItems } from "../filer";
import { joinAbsRel } from "../worktree";
import { useFileContextMenu } from "./useFileContextMenu";

const { Popover, context, close } = useFileContextMenu();

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

/** context → FileActionMenuItems props の変換。閉じているときは undefined で項目ごと消す */
const itemProps = computed(() => {
  const ctx = context.value;
  if (ctx === undefined) return undefined;
  return {
    absPath: joinAbsRel(ctx.dir, ctx.relPath),
    displayName: ctx.relPath,
    commitHash: ctx.commitHash,
    openable: !ctx.isSnapshot,
  };
});
</script>

<template>
  <Popover
    class="m-0 min-w-36 rounded-lg border border-border bg-background py-1 text-sm text-foreground shadow-lg"
    :style="popoverStyle"
  >
    <FileActionMenuItems v-if="itemProps" v-bind="itemProps" @close="close()" />
  </Popover>
</template>
