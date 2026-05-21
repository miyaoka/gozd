<doc lang="md">
marked で Markdown → HTML 変換し、DOMPurify でサニタイズして表示する。

- YAML frontmatter はコードブロックとして描画
- 相対パスリンクのクリックは worktree 相対パスとして解決し、プレビュー対象を切り替える
  （http(s) / mailto: 等の絶対 URL は `ExternalLinkNavigationDecider` 経路で外部ブラウザに渡す）
</doc>

<script setup lang="ts">
import DOMPurify from "dompurify";
import { marked, type MarkedExtension } from "marked";
import { ref, watch } from "vue";
import { relDirOf } from "../filer";
import { useWorktreeStore } from "../worktree";

const props = defineProps<{
  content: string;
}>();

const worktreeStore = useWorktreeStore();

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

/** scheme 付き URL（http://、mailto: 等）かどうかを判定 */
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * リンクの相対パス解決:
 * - `/` 始まり: worktree ルート基準の絶対（先頭の `/` を除去して相対化）
 * - それ以外: 現在の `selectedPath` のディレクトリ基準で結合
 * normalizePath は `worktreeStore.selectPath` 側で実行されるためここでは行わない。
 */
function resolveRelativeLink(href: string): string {
  if (href.startsWith("/")) return href.substring(1);
  const basePath = worktreeStore.selectedPath;
  const baseDir = basePath === undefined ? "" : relDirOf(basePath);
  return baseDir === "" ? href : `${baseDir}/${href}`;
}

function onLinkClick(e: MouseEvent) {
  // modifier 付きクリックは新規ウィンドウ等の意図とみなさずデフォルトに任せる経路を残さない:
  // 単一 WebView 構成なので middle/cmd click でも内部遷移として扱う
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const anchor = target.closest("a");
  if (anchor === null) return;
  const href = anchor.getAttribute("href");
  if (href === null || href === "") return;

  // フラグメントのみ: 同一文書内アンカー。ブラウザのデフォルトスクロールに任せる
  if (href.startsWith("#")) return;

  // 絶対 URL（http://、mailto: 等）: NavigationDecider が外部ブラウザに送る
  if (URL_SCHEME_RE.test(href)) return;

  // 相対パス: プレビュー切り替え
  e.preventDefault();
  const hashIdx = href.indexOf("#");
  const pathPart = hashIdx >= 0 ? href.substring(0, hashIdx) : href;
  if (pathPart === "") return;
  worktreeStore.selectPath(resolveRelativeLink(pathPart));
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
