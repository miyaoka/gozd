<script setup lang="ts">
import DOMPurify from "dompurify";
import { marked, type MarkedExtension } from "marked";
import mermaid from "mermaid";
import { ref, watch, onMounted } from "vue";

const props = defineProps<{
  content: string;
}>();

const renderedHtml = ref<string>();
let mermaidInitialized = false;
let mermaidIdCounter = 0;

/** mermaid を初期化（一度だけ） */
function ensureMermaidInit() {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    fontFamily: "inherit",
  });
  mermaidInitialized = true;
}

/** ```mermaid コードブロックを SVG に変換する marked extension */
const mermaidExtension: MarkedExtension = {
  renderer: {
    code({ text, lang }) {
      if (lang === "mermaid") {
        const id = `mermaid-placeholder-${mermaidIdCounter++}`;
        return `<div class="_mermaid-block" data-mermaid-id="${id}" data-mermaid-source="${encodeURIComponent(text)}"></div>`;
      }
      return false;
    },
  },
};

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

marked.use(frontmatterExtension, mermaidExtension);

const container = ref<HTMLElement>();

/** mermaid ブロックのプレースホルダを実際の SVG に差し替える */
async function renderMermaidBlocks() {
  if (!container.value) return;
  ensureMermaidInit();

  const blocks = container.value.querySelectorAll<HTMLElement>("._mermaid-block");
  for (const block of blocks) {
    const source = block.dataset.mermaidSource;
    const id = block.dataset.mermaidId;
    if (!source || !id) continue;

    const decoded = decodeURIComponent(source);
    const result = await mermaid.render(id, decoded);
    block.innerHTML = result.svg;
  }
}

watch(
  () => props.content,
  async (content) => {
    const rawHtml = await marked.parse(content);
    renderedHtml.value = DOMPurify.sanitize(rawHtml);
    // DOM 更新後に mermaid を描画
    requestAnimationFrame(() => {
      renderMermaidBlocks();
    });
  },
  { immediate: true },
);

onMounted(() => {
  renderMermaidBlocks();
});
</script>

<template>
  <div ref="container" class="_markdown-body p-6 text-sm/relaxed" v-html="renderedHtml" />
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

/* GitHub 形式のアラート (> [!NOTE] 等) */
._markdown-body :deep(._mermaid-block) {
  margin: 0.75em 0;
  display: flex;
  justify-content: center;
}

._markdown-body :deep(._mermaid-block svg) {
  max-width: 100%;
}
</style>
