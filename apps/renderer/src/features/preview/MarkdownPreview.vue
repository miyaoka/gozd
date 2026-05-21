<doc lang="md">
marked で Markdown → HTML 変換し、DOMPurify でサニタイズして表示する。

- YAML frontmatter はコードブロックとして描画
- 相対パスリンクのクリックは worktree 相対パスとして解決し、プレビュー対象を切り替える
  （http(s) / mailto: 等の絶対 URL は `ExternalLinkNavigationDecider` 経路で外部ブラウザに渡す）
- 行番号フラグメント (`./foo.ts#L42`) は lineNumber として `selectPath` に渡す
- 解決ロジックは `resolveMarkdownLink` に分離 (純粋関数 + ユニットテスト)
</doc>

<script setup lang="ts">
import DOMPurify from "dompurify";
import { marked, type MarkedExtension } from "marked";
import { ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { relDirOf } from "../filer";
import { normalizeAbsolute, normalizeRelative, useWorktreeStore } from "../worktree";
import { resolveMarkdownLink } from "./resolveMarkdownLink";

const props = defineProps<{
  content: string;
}>();

const worktreeStore = useWorktreeStore();
const notification = useNotificationStore();

const renderedHtml = ref<string>();

/** YAML frontmatter を ```yaml コードブロックに変換して表示する */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

const frontmatterExtension: MarkedExtension = {
  hooks: {
    preprocess(markdown) {
      return markdown.replace(
        FRONTMATTER_RE,
        (_match, yaml: string) => `\`\`\`yaml\n${yaml}\n\`\`\`\n`,
      );
    },
  },
};

marked.use(frontmatterExtension);

watch(
  () => props.content,
  async (content) => {
    const rawHtml = await marked.parse(content);
    renderedHtml.value = DOMPurify.sanitize(rawHtml);
  },
  { immediate: true },
);

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
  worktreeStore.selectFromTarget(resolved.selection, resolved.lineNumber);
}
</script>

<template>
  <div class="_markdown-body p-6 text-sm/relaxed" v-html="renderedHtml" @click="onLinkClick" />
</template>

<style scoped>
/* Markdown レンダリングのスタイル */
/* 先頭要素の上マージンを消す */
._markdown-body :deep(> :first-child) {
  margin-top: 0;
}

._markdown-body :deep(h1) {
  font-size: 1.75em;
  font-weight: 700;
  margin: 1.5em 0 0.5em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--color-zinc-700);
  color: var(--color-zinc-100);
}

._markdown-body :deep(h2) {
  font-size: 1.4em;
  font-weight: 600;
  margin: 1.25em 0 0.5em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--color-zinc-700);
  color: var(--color-zinc-100);
}

._markdown-body :deep(h3) {
  font-size: 1.15em;
  font-weight: 600;
  margin: 1em 0 0.5em;
  color: var(--color-zinc-200);
}

._markdown-body :deep(h4),
._markdown-body :deep(h5),
._markdown-body :deep(h6) {
  font-weight: 600;
  margin: 1em 0 0.5em;
  color: var(--color-zinc-300);
}

._markdown-body :deep(p) {
  margin: 0.75em 0;
  color: var(--color-zinc-300);
}

._markdown-body :deep(a) {
  color: var(--color-blue-400);
  text-decoration: underline;
}

._markdown-body :deep(strong) {
  color: var(--color-zinc-100);
}

._markdown-body :deep(ul),
._markdown-body :deep(ol) {
  margin: 0.5em 0;
  padding-left: 1.5em;
  color: var(--color-zinc-300);
}

._markdown-body :deep(ul) {
  list-style-type: disc;
}

._markdown-body :deep(ol) {
  list-style-type: decimal;
}

._markdown-body :deep(li) {
  margin: 0.25em 0;
}

._markdown-body :deep(blockquote) {
  margin: 0.75em 0;
  padding: 0.5em 1em;
  border-left: 3px solid var(--color-zinc-600);
  color: var(--color-zinc-400);
}

._markdown-body :deep(code) {
  padding: 0.15em 0.4em;
  border-radius: 3px;
  background: var(--color-zinc-800);
  color: var(--color-zinc-200);
  font-size: 0.9em;
}

._markdown-body :deep(pre) {
  margin: 0.75em 0;
  padding: 1em;
  border-radius: 6px;
  background: var(--color-zinc-800);
  overflow-x: auto;
}

._markdown-body :deep(pre code) {
  padding: 0;
  background: transparent;
  line-height: 1.375;
}

._markdown-body :deep(table) {
  width: 100%;
  margin: 0.75em 0;
  border-collapse: collapse;
}

._markdown-body :deep(th),
._markdown-body :deep(td) {
  padding: 0.5em 0.75em;
  border: 1px solid var(--color-zinc-700);
  color: var(--color-zinc-300);
}

._markdown-body :deep(th) {
  background: var(--color-zinc-800);
  font-weight: 600;
  color: var(--color-zinc-200);
}

._markdown-body :deep(hr) {
  margin: 1.5em 0;
  border: none;
  border-top: 1px solid var(--color-zinc-700);
}

._markdown-body :deep(img) {
  max-width: 100%;
}
</style>
