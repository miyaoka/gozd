<doc lang="md">
Markdown 文字列を marked で HTML 変換し DOMPurify でサニタイズして描画する
プレゼンテーション専用コンポーネント。リンクのナビゲーション挙動は持たず、クリックを
`linkClick` イベントで上位に委譲するだけ。

- YAML frontmatter は ```yaml コードブロックに変換して描画する
- padding / 文字サイズは consumer ごとに異なるため持たせず、class フォールスルーで外から渡す
  (preview は `p-6`、session log dialog は `px-3 py-2` 等)
- 相対リンク解決 / 履歴ナビゲーションが必要な consumer は `linkClick` を購読して処理する
  (MarkdownPreview 参照)。購読しない場合はブラウザ既定挙動 + `ExternalLinkNavigationDecider`
  に委ねられる
</doc>

<script setup lang="ts">
import DOMPurify from "dompurify";
import { marked, type MarkedExtension } from "marked";
import { nextTick, ref, watch } from "vue";

const props = defineProps<{
  content: string;
}>();

const emit = defineEmits<{
  linkClick: [event: MouseEvent];
  // marked の async parse + DOM 反映が完了したタイミング。consumer が描画後の
  // レイアウト確定 (高さ等) に依存する処理 (scroll-spy の observe 等) のフックに使う。
  rendered: [];
}>();

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
    // DOM 反映後に rendered を通知し、高さ確定に依存する consumer のフックにする。
    await nextTick();
    emit("rendered");
  },
  { immediate: true },
);
</script>

<template>
  <div class="_markdown-body" v-html="renderedHtml" @click="emit('linkClick', $event)" />
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
