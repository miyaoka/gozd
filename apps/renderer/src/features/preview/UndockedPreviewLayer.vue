<doc lang="md">
undock されたファイルプレビューウィンドウ群を描画する app-scope レイヤー。

ファイル選択 / worktree の切り替えと独立してウィンドウを生存させるため、選択に結合した
ペイン階層ではなく app scope に置く (state は module singleton)。各ウィンドウの実体は
undock 直後は main window 内の in-app パネルで、昇格後は別 OS ウィンドウになる
(presentation の切り替えは UndockedPreviewWindow → UndockedWindow に閉じる)。
</doc>

<script setup lang="ts">
import UndockedPreviewWindow from "./UndockedPreviewWindow.vue";
import { useUndockedPreview } from "./useUndockedPreview";

const { previews } = useUndockedPreview();
</script>

<template>
  <UndockedPreviewWindow v-for="preview in previews" :key="preview.id" :preview="preview" />
</template>
