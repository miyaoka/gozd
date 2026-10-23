<doc lang="md">
marked で Markdown → HTML 変換し、DOMPurify でサニタイズして表示する。

- YAML frontmatter はコードブロックとして描画
- 相対パスリンクのクリックは worktree 相対パスとして解決し、プレビュー対象を切り替える
- 外部 URL (http(s) / mailto:) は MarkdownBody が開く。ここに来る href は内部リンクだけ
- 行番号フラグメント (`./foo.ts#L42`) は lineNumber として `selectPath` に渡す
- 解決ロジックは `resolveMarkdownLink` に分離 (純粋関数 + ユニットテスト)
- 内部リンクの遷移は `useMarkdownHistoryStore.navigate()` 経由で行い、back / forward 履歴に積む。
  filer / terminal などの外部経路で selection が変わると履歴は破棄される (詳細は `useMarkdownHistoryStore` を参照)
- 画像は HTML preview と同じ配信 scheme から読む。`target` の root を配信許可として登録し、
  `<img src>` をその URL に書き換える (`resolveMarkdownImageSrc`)。配信は working tree の
  実ファイルを読むため、過去の版を表示していても画像は今のものになる (リンクの解決と同じ基準)
</doc>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
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
  [() => props.target?.absPath, () => props.target?.root],
  async ([absPath, root]) => {
    const mySeq = ++imageBaseSeq;
    imageBase.value = undefined;
    if (absPath === undefined || root === undefined) return;
    const result = await serving.requestUrl(absPath, root);
    if (mySeq !== imageBaseSeq) return;
    if (!result.ok) {
      notification.error(
        IMAGE_BASE_FAILED_MESSAGE,
        new Error(`path=${absPath}`, { cause: result.error }),
      );
      return;
    }
    imageBase.value = markdownImageBase(result.value.url, absPath, root);
  },
  { immediate: true },
);

const resolveImageSrc = computed(() => {
  const base = imageBase.value;
  return (src: string) => resolveMarkdownImageSrc(src, base, normalizeAbsolute);
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
    @link-click="onLinkClick"
    @beforeinput="blockEdit"
    @compositionstart="abortComposition"
    @dragover.prevent
    @drop.prevent
  />
</template>
