<doc lang="md">
画像ファイルのプレビュー。ファイルサーバー経由の URL を `src` として受け取り、
アスペクト比を保ったまま中央に表示する。

`<img>` 読み込み失敗 (handler の throw / MIME 不一致 / fetch エラー) は `error` イベントで親へ通知する。
silent broken-image アイコンに倒さず PreviewPane の error 表示と挙動を揃える。
</doc>

<script setup lang="ts">
defineProps<{
  /** `<img>` の src。`gozd-file://` URLSchemeHandler 経由の URL を想定 */
  src: string;
}>();

const emit = defineEmits<{
  error: [];
}>();
</script>

<template>
  <div class="flex flex-1 items-center justify-center p-4">
    <img :src="src" class="max-h-full max-w-full object-contain" alt="" @error="emit('error')" />
  </div>
</template>
