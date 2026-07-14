<doc lang="md">
pin されたファイルプレビューウィンドウ群を描画する app-scope レイヤー。

ファイル選択 / worktree の切り替えと独立してウィンドウを生存させるため、選択に結合した
ペイン階層ではなく app scope に置く (state は module singleton)。
</doc>

<script setup lang="ts">
import PinnedPreviewWindow from "./PinnedPreviewWindow.vue";
import { usePinnedPreview } from "./usePinnedPreview";

const { previews } = usePinnedPreview();
</script>

<template>
  <PinnedPreviewWindow v-for="preview in previews" :key="preview.id" :preview="preview" />
</template>
