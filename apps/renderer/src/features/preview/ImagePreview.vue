<script setup lang="ts">
import type { WireBytes } from "@gozd/rpc";
import { useObjectUrl } from "@vueuse/core";
import { computed } from "vue";
import { imageMimeType } from "./previewFileType";

const props = defineProps<{
  /** 画像の中身。バイナリ画像は bytes、SVG はテキスト */
  source: string | WireBytes;
  /** MIME 導出用のファイルパス（previewFileType の拡張子表が SSOT） */
  filePath: string;
}>();

const emit = defineEmits<{
  error: [];
}>();

const blob = computed(() => new Blob([props.source], { type: imageMimeType(props.filePath) }));
const url = useObjectUrl(blob);
</script>

<template>
  <div class="flex flex-1 items-center justify-center p-4">
    <img
      v-if="url"
      :src="url"
      class="max-h-full max-w-full object-contain"
      alt=""
      @error="emit('error')"
    />
  </div>
</template>
