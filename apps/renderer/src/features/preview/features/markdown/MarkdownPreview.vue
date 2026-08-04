<doc lang="md">
marked で Markdown → HTML 変換し、DOMPurify でサニタイズして表示する。

- YAML frontmatter はコードブロックとして描画
- 相対パスリンクのクリックは worktree 相対パスとして解決し、プレビュー対象を切り替える
- 外部 URL (http(s) / mailto:) は MarkdownBody が開く。ここに来る href は内部リンクだけ
- 行番号フラグメント (`./foo.ts#L42`) は lineNumber として `selectPath` に渡す
- 解決ロジックは `resolveMarkdownLink` に分離 (純粋関数 + ユニットテスト)
- 内部リンクの遷移は `useMarkdownHistoryStore.navigate()` 経由で行い、back / forward 履歴に積む。
  filer / terminal などの外部経路で selection が変わると履歴は破棄される (詳細は `useMarkdownHistoryStore` を参照)
</doc>

<script setup lang="ts">
import { useNotificationStore } from "../../../../shared/notification";
import { relDirOf } from "../../../filer";
import { normalizeAbsolute, normalizeRelative, useWorktreeStore } from "../../../worktree";
import { abortComposition, blockEdit } from "../../contenteditableHostGuard";
import MarkdownBody from "./MarkdownBody.vue";
import { resolveMarkdownLink } from "./resolveMarkdownLink";
import { useMarkdownHistoryStore } from "./useMarkdownHistoryStore";

defineProps<{
  content: string;
}>();

const worktreeStore = useWorktreeStore();
const markdownHistory = useMarkdownHistoryStore();
const notification = useNotificationStore();

/**
 * MarkdownBody が外部送りと `preventDefault` を済ませた後の href を受け、worktree 相対として
 * 解決する。middle click (`auxclick`) は bind されないため WebView の既定挙動のまま
 * (VS Code でも内部リンクとして扱わない)。
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
    @link-click="onLinkClick"
    @beforeinput="blockEdit"
    @compositionstart="abortComposition"
    @dragover.prevent
    @drop.prevent
  />
</template>
