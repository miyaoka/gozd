<doc lang="md">
undock されたファイルプレビューウィンドウ群を描画する app-scope レイヤー。

ファイル選択 / worktree の切り替えと独立してウィンドウを生存させるため、選択に結合した
ペイン階層ではなく app scope に置く (state は module singleton)。各ウィンドウの実体は
別 OS ウィンドウ (ChildWindow) で、このレイヤー自体はメインウィンドウ内に何も描画しない。
</doc>

<script setup lang="ts">
import UndockedPreviewWindow from "./UndockedPreviewWindow.vue";
import { useUndockedPreview } from "./useUndockedPreview";

const { previews } = useUndockedPreview();
</script>

<template>
  <UndockedPreviewWindow v-for="preview in previews" :key="preview.id" :preview="preview" />
</template>
