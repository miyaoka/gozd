<doc lang="md">
session log の tool イベント見出しに出す主要引数プレビュー。代表キー (command / file_path 等)
を優先順で 1 つ拾い、preview を computed で 1 回だけ算出する。preview が空なら何も描画しない。

パス系キー (file_path / path) は絶対パスが行を占有するため **basename だけ表示**し、
フルパスは title (hover) に回す。コマンド等はそのまま (長い場合は CSS truncate)。
</doc>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  input: Record<string, unknown>;
}>();

/** 代表キーを優先順で拾う。最初に見つかった非空 string を採用する。 */
const TOOL_PRIMARY_KEYS = ["command", "file_path", "path", "pattern", "query", "url"];
// パス系は basename に縮約する。絶対パスのフルは title に回し、行を占有させない。
const PATH_KEYS = new Set(["file_path", "path"]);

interface ArgPreview {
  /** chip に表示する縮約後テキスト (パスなら basename) */
  label: string;
  /** title (hover) 用のフル値 */
  full: string;
}

const preview = computed<ArgPreview | undefined>(() => {
  for (const key of TOOL_PRIMARY_KEYS) {
    const value = props.input[key];
    if (typeof value !== "string" || value === "") continue;
    if (PATH_KEYS.has(key)) {
      // 末尾区切りを除いた最後のセグメント。空なら元値に倒す。
      const [basename = value] = value.replace(/\/+$/, "").split("/").slice(-1);
      return { label: basename, full: value };
    }
    return { label: value, full: value };
  }
  return undefined;
});
</script>

<template>
  <span v-if="preview" class="min-w-0 truncate text-zinc-500" :title="preview.full">{{
    preview.label
  }}</span>
</template>
