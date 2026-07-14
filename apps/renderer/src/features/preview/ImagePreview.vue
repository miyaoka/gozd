<doc lang="md">
画像 / SVG のプレビュー。取得時点 / pin 時点の中身（バイナリ画像は bytes、SVG はテキスト）
から Blob → ObjectURL を作り、アスペクト比を保ったまま中央に表示する。

表示がファイルの再読込（URL fetch）に依存しないため、データ取得層の意味論
（live の再取得 / snapshot の固定）がそのまま表示に反映される。ObjectURL は
source 変化で作り直し、unmount で revoke する（useObjectUrl）。

`<img>` 読み込み失敗（壊れた bytes / MIME 不一致）は `error` イベントで親へ通知する。
silent broken-image アイコンに倒さず error 表示と挙動を揃える。
</doc>

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
