<doc lang="md">
ファイル行の右クリックメニュー。項目 (Open in default app / Copy file / Copy path) は
preview ヘッダの ⋮ メニューと共通の `FileActionMenuItems` (filer) を描画する。
context の組み立てと snapshot semantics、defer / disconnect ガード等の内部仕様は
`useFileContextMenu.ts` の docstring を SSOT として参照する。

Open / Copy file は snapshot mode (context.isSnapshot) では出さない。可視判定の理由は
FileActionMenuItems の doc を参照 (openable prop に反転して渡す)。
</doc>

<script setup lang="ts">
import { computed, type CSSProperties } from "vue";
import { FileActionMenuItems } from "../filer";
import { joinAbsRel } from "../worktree";
import { useFileContextMenu } from "./useFileContextMenu";

const { Popover, context, close } = useFileContextMenu();

/**
 * 右クリック座標 (context.x/y) に置く不可視の 0 サイズ anchor。popover に left/top を直書きすると
 * viewport 右端 / 下端で `position-try-fallbacks` が効かず見切れるため、座標は anchor 要素側に
 * 持たせ、popover は常に CSS Anchor Positioning (position-area + flip fallback) で配置する
 * (BlamePopover の「コンポーネント所有の不可視 anchor を幾何座標に重ねる」方式と同型)。
 * `showPopover({ source })` の implicit anchor (行要素) は positionAnchor 指定で上書きされる。
 */
const originAnchorStyle = computed<CSSProperties | undefined>(() => {
  const ctx = context.value;
  if (ctx === undefined) return undefined;
  return {
    position: "fixed",
    left: `${ctx.x}px`,
    top: `${ctx.y}px`,
    anchorName: "--file-context-menu-origin",
  };
});

// マウス座標 (不可視 anchor) の bottom-right へ出し、viewport 端では flip する
const popoverStyle = {
  position: "fixed",
  positionAnchor: "--file-context-menu-origin",
  positionArea: "block-end span-inline-end",
  positionTryFallbacks: "flip-block, flip-inline, flip-block flip-inline",
};

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
  <!-- 不可視 anchor は positioned element (popover) より DOM 前方に置く (acceptable anchor 条件) -->
  <div v-if="originAnchorStyle" :style="originAnchorStyle" aria-hidden="true" />
  <Popover
    class="m-0 min-w-36 rounded-lg border border-border bg-background py-1 text-sm text-foreground shadow-lg"
    :style="popoverStyle"
  >
    <FileActionMenuItems v-if="itemProps" v-bind="itemProps" @close="close()" />
  </Popover>
</template>
