<doc lang="md">
pin されたファイルプレビューウィンドウ群を描画する app-scope レイヤー。

App.vue 直下にマウントし、ファイル選択 / worktree の切り替えと独立してウィンドウを
生存させる (state は `usePinnedPreview` の module singleton)。個々のウィンドウの
ドラッグ / リサイズ / close は PinnedPreviewWindow に閉じる。
</doc>

<script setup lang="ts">
import PinnedPreviewWindow from "./PinnedPreviewWindow.vue";
import { usePinnedPreview } from "./usePinnedPreview";

const { previews } = usePinnedPreview();
</script>

<template>
  <PinnedPreviewWindow v-for="preview in previews" :key="preview.id" :preview="preview" />
</template>
