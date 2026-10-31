<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import { useNotificationStore } from "../../../../shared/notification";
import { relDirOf } from "../../../filer";
import { normalizeAbsolute, normalizeRelative, useWorktreeStore } from "../../../worktree";
import { abortComposition, blockEdit } from "../../contenteditableHostGuard";
import type { PreviewServingTarget } from "../../previewServingTarget";
import { usePreviewServing } from "../../usePreviewServing";
import MarkdownBody from "./MarkdownBody.vue";
import {
  markdownImageBase,
  resolveMarkdownImageSrc,
  type MarkdownImageBase,
} from "./resolveMarkdownImageSrc";
import { resolveMarkdownLink } from "./resolveMarkdownLink";
import { useMarkdownHistoryStore } from "./useMarkdownHistoryStore";
import { useMarkdownImageWatch } from "./useMarkdownImageWatch";

const props = defineProps<{
  content: string;
  /** 画像の配信対象 (markdown 自身の絶対パスと配信を許す root)。undefined なら相対の画像は読まない */
  target?: PreviewServingTarget;
}>();

const worktreeStore = useWorktreeStore();
const markdownHistory = useMarkdownHistoryStore();
const notification = useNotificationStore();

const serving = usePreviewServing();
const imageBase = ref<MarkdownImageBase>();
/** 対象の切替で RPC が並行したとき、古い応答で別ファイルの base を置かないためのカウンター */
let imageBaseSeq = 0;
const IMAGE_BASE_FAILED_MESSAGE = "Could not load images in markdown preview";

// 値ごとのソースにする。target は選択のたびに作り直されるため、1 つの getter で配列を返すと
// 同じファイルの再選択でも発火し、画像の src が外れて配信 URL を取り直す
watch(
  [() => props.target?.absPath, () => props.target?.root, () => props.target?.scope],
  async ([absPath, root, scope]) => {
    const mySeq = ++imageBaseSeq;
    imageBase.value = undefined;
    if (absPath === undefined || root === undefined || scope === undefined) return;
    const result = await serving.requestUrl(absPath, root);
    if (mySeq !== imageBaseSeq) return;
    if (!result.ok) {
      notification.error(
        IMAGE_BASE_FAILED_MESSAGE,
        new Error(`path=${absPath}`, { cause: result.error }),
      );
      return;
    }
    imageBase.value = markdownImageBase(result.value.url, { absPath, root, scope });
  },
  { immediate: true },
);

/** 画像ファイルの変更で進める版数。画像の URL に載せて読み直させる */
const imageEpoch = ref(0);
/** 直近の描画が配信 scheme から読んだ画像の絶対パス。変更の監視対象 */
const imagePaths = shallowRef<ReadonlySet<string>>(new Set());
/**
 * 描画中に書き換えた画像のパス。描画の完了で `imagePaths` に移す。MarkdownBody は最後に始まった
 * 描画でだけ `rendered` を出すが、sanitize まで進んだ古い描画のパスはここに残る。監視が余分に
 * 張られるだけで、次の描画で外れる
 */
let renderingPaths = new Set<string>();

const resolveImageSrc = computed(() => {
  const base = imageBase.value;
  const epoch = imageEpoch.value;
  return (src: string) => {
    const resolved = resolveMarkdownImageSrc(src, base, normalizeAbsolute);
    if (resolved?.servedPath === undefined) return resolved?.url;
    renderingPaths.add(resolved.servedPath);
    if (epoch === 0) return resolved.url;
    // 配信は pathname しか見ないため query は無害（HtmlPreview の再 load と同じ）
    const url = new URL(resolved.url);
    url.searchParams.set("e", String(epoch));
    return url.href;
  };
});

function onRendered() {
  imagePaths.value = renderingPaths;
  renderingPaths = new Set();
}

useMarkdownImageWatch(imagePaths, () => {
  imageEpoch.value++;
});

/**
 * MarkdownBody が外部送りと `preventDefault` を済ませた後の href を受け、worktree 相対として
 * 解決する。左クリックと中クリックは同じ経路で届く。
 *
 * notification は **固定 message + 詳細を `cause` に分離** する。
 * `useNotificationStore` は同一 message を重複抑制するため、href 違いのリンクを連続
 * クリックしてもトーストが累積しない。href の生値は `cause` 側にだけ保持し、トースト
 * 詳細パネルで確認できる経路を残す。
 */
const ANCHOR_IGNORED_MESSAGE = "Heading anchors are not yet supported; opened the file only";
const LINK_INVALID_MESSAGE = "Could not open link from markdown preview";

function onLinkClick(href: string) {
  const resolved = resolveMarkdownLink({
    href,
    basePath: worktreeStore.selection,
    relDirOf,
    normalizeRelative,
    normalizeAbsolute,
  });

  // passthrough (`#fragment` 単独) は MarkdownBody が素通しするためここには来ない
  if (resolved.kind === "passthrough") return;

  if (resolved.kind === "invalid") {
    notification.error(LINK_INVALID_MESSAGE, { href, reason: resolved.reason });
    return;
  }

  if (resolved.droppedAnchor) {
    notification.info(ANCHOR_IGNORED_MESSAGE, { href });
  }
  markdownHistory.navigate(resolved.selection, resolved.lineNumber);
}
</script>

<template>
  <MarkdownBody
    class="p-6 text-sm/relaxed"
    contenteditable="true"
    spellcheck="false"
    autocorrect="off"
    autocapitalize="off"
    role="region"
    aria-label="Markdown contents"
    :content="content"
    :resolve-image-src="resolveImageSrc"
    @rendered="onRendered"
    @link-click="onLinkClick"
    @beforeinput="blockEdit"
    @compositionstart="abortComposition"
    @dragover.prevent
    @drop.prevent
  />
</template>
