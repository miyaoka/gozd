<script setup lang="ts">
import { computed, ref, watch } from "vue";
import RepoEmblem from "./RepoEmblem.vue";
import { REPO_ICON_SIZE_CLASS, type RepoIconSize } from "./repoIconSize";

const props = defineProps<{
  /** identicon の種 (repo 名) */
  name: string;
  /** GitHub owner。undefined は解決中、空文字は解決済みで owner なし */
  owner: string | undefined;
  /** 既定は md */
  size?: RepoIconSize;
}>();

/** 最大の表示は 24px (size-6)。Retina 向けに 2x を要求する */
const AVATAR_FETCH_SIZE = 48;

const sizeClass = computed(() => REPO_ICON_SIZE_CLASS[props.size ?? "md"]);

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
  <span
    v-if="owner === undefined"
    class="shrink-0"
    :class="sizeClass.box"
    aria-hidden="true"
  ></span>
  <img
    v-else-if="owner !== '' && !failed"
    :src="`https://github.com/${owner}.png?size=${AVATAR_FETCH_SIZE}`"
    alt=""
    aria-hidden="true"
    class="shrink-0"
    :class="[sizeClass.box, sizeClass.rounded]"
    @error="failed = true"
  />
  <RepoEmblem v-else :name="name" :size="size" />
</template>
