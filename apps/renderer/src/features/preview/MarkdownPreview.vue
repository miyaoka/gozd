<doc lang="md">
marked で Markdown → HTML 変換し、DOMPurify でサニタイズして表示する。

- YAML frontmatter はコードブロックとして描画
- 相対パスリンクのクリックは worktree 相対パスとして解決し、プレビュー対象を切り替える
  （http(s) / mailto: 等の絶対 URL は `ExternalLinkNavigationDecider` 経路で外部ブラウザに渡す）
- 行番号フラグメント (`./foo.ts#L42`) は lineNumber として `selectPath` に渡す
- 解決ロジックは `resolveMarkdownLink` に分離 (純粋関数 + ユニットテスト)
- 内部リンクの遷移は `useMarkdownHistoryStore.navigate()` 経由で行い、back / forward 履歴に積む。
  filer / terminal などの外部経路で selection が変わると履歴は破棄される (詳細は `useMarkdownHistoryStore` を参照)
</doc>

<script setup lang="ts">
import { useNotificationStore } from "../../shared/notification";
import { relDirOf } from "../filer";
import { normalizeAbsolute, normalizeRelative, useWorktreeStore } from "../worktree";
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
 * クリック経路は VS Code (`markdown-language-features/preview-src/index.ts`) に揃える。
 * - 左クリックの `@click` のみ。middle click (`auxclick`) は WebView の既定挙動に任せる
 *   (VS Code でも未対応 / 内部リンクとして扱わない)
 * - scheme 付き URL と `#fragment` 単独は preventDefault せず素通しし、
 *   `ExternalLinkNavigationDecider` (外部 URL) / ブラウザ既定スクロール (`#`) に委ねる
 *
 * notification は **固定 message + 詳細を `cause` に分離** する。
 * `useNotificationStore` は同一 message を重複抑制するため、href 違いのリンクを連続
 * クリックしてもトーストが累積しない。href の生値は `cause` 側にだけ保持し、トースト
 * 詳細パネルで確認できる経路を残す。
 */
const ANCHOR_IGNORED_MESSAGE = "Heading anchors are not yet supported; opened the file only";
const LINK_INVALID_MESSAGE = "Could not open link from markdown preview";

function onLinkClick(e: MouseEvent) {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const anchor = target.closest("a");
  if (anchor === null) return;
  const href = anchor.getAttribute("href");
  if (href === null) return;

  const resolved = resolveMarkdownLink({
    href,
    basePath: worktreeStore.selection,
    relDirOf,
    normalizeRelative,
    normalizeAbsolute,
  });

  if (resolved.kind === "passthrough") return;

  e.preventDefault();

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
  <MarkdownBody class="p-6 text-sm/relaxed" :content="content" @link-click="onLinkClick" />
</template>
