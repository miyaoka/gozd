<script setup lang="ts">
import UndockedPreviewWindow from "./UndockedPreviewWindow.vue";
import { useUndockedPreview } from "./useUndockedPreview";

const { previews } = useUndockedPreview();
</script>

<template>
  <UndockedPreviewWindow v-for="preview in previews" :key="preview.id" :preview="preview" />
</template>
