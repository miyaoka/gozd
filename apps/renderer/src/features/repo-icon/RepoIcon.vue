<doc lang="md">
repo の識別アイコン。GitHub owner (org / 個人ユーザー) が解決できたらアバター単体、
owner 未解決 (非 github.com remote / remote 未設定) と画像ロード失敗 (オフライン等) は
identicon (RepoEmblem) を出す。

アバター URL は `https://github.com/<owner>.png` (GitHub 公式の redirect エンドポイント、
org / 個人ユーザー共通)。owner さえあれば追加の API 呼び出しなしで解決できる。
`<img>` は passive content なので gozd の CORS 防御規律 (fetch の bytes 回収遮断) と
衝突せずに表示できる。
</doc>

<script setup lang="ts">
import { ref, watch } from "vue";
import RepoEmblem from "./RepoEmblem.vue";

const props = defineProps<{
  /** identicon の種 (repo 名) */
  name: string;
  /** GitHub owner。空文字は未解決 */
  owner: string;
}>();

/** 表示は 24px (size-6)。Retina 向けに 2x を要求する */
const AVATAR_FETCH_SIZE = 48;

/** 画像ロード失敗フラグ。owner が変わったら再試行する */
const failed = ref(false);
watch(
  () => props.owner,
  () => {
    failed.value = false;
  },
);
</script>

<template>
  <img
    v-if="owner !== '' && !failed"
    :src="`https://github.com/${owner}.png?size=${AVATAR_FETCH_SIZE}`"
    alt=""
    aria-hidden="true"
    class="size-6 shrink-0 rounded-md"
    @error="failed = true"
  />
  <RepoEmblem v-else :name="name" />
</template>
