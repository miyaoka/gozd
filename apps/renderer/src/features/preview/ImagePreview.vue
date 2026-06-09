<doc lang="md">
画像ファイルのプレビュー。ファイルサーバー経由の URL を `src` として受け取り、
アスペクト比を保ったまま中央に表示する。
</doc>

<script setup lang="ts">
defineProps<{
  /** `<img>` の src。`gozd-file://` URLSchemeHandler 経由の URL を想定 */
  src: string;
}>();
</script>

<template>
  <div class="flex flex-1 items-center justify-center p-4">
    <img :src="src" class="max-h-full max-w-full object-contain" alt="" />
  </div>
</template>
