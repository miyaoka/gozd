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
/*
 * 本文テキストの折り返し規律。overflow-wrap は継承プロパティなので、ルートに一度
 * 指定すれば p / li など全子孫に効く。区切り線 (───) や長い URL のように区切り文字を
 * 含まない連続文字列は default の overflow-wrap: normal だと 1 単語として扱われ、狭い
 * コンテナ (チャット吹き出し等) からはみ出すため anywhere で強制的に折り返す。
 * インラインコードは :not(pre) > code で別途 anywhere を当てており競合しない。
 */
._markdown-body {
  overflow-wrap: anywhere;
  /* markdown 本文はコピー対象コンテンツ。MarkdownPreview では contenteditable host として
     base 層の [contenteditable] 規則でも text になるが、session-log / terminal preview では
     contenteditable 無しで使われるため、host 自身に明示して全経路で選択可を担保する。
     WebKit (WKWebView) は -webkit- プレフィックス無しの user-select を無視するため両方書く。 */
  -webkit-user-select: text;
  user-select: text;
}

/* contenteditable host として focus を取る経路 (MarkdownPreview 経由) で、keyboard focus
   時だけ outline を出す。click focus は UA 既定 (outline なし) のまま。 */
._markdown-body:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}

/* 先頭要素の上マージンを消す */
._markdown-body :deep(> :first-child) {
  margin-top: 0;
}

._markdown-body :deep(h1) {
  font-size: 1.75em;
  font-weight: 700;
  margin: 1.5em 0 0.5em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--color-element);
  color: var(--color-foreground);
}

._markdown-body :deep(h2) {
  font-size: 1.4em;
  font-weight: 600;
  margin: 1.25em 0 0.5em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--color-element);
  color: var(--color-foreground);
}

._markdown-body :deep(h3) {
  font-size: 1.15em;
  font-weight: 600;
  margin: 1em 0 0.5em;
  color: var(--color-foreground);
}

._markdown-body :deep(h4),
._markdown-body :deep(h5),
._markdown-body :deep(h6) {
  font-weight: 600;
  margin: 1em 0 0.5em;
  color: var(--color-foreground);
}

._markdown-body :deep(p) {
  margin: 0.75em 0;
  color: var(--color-foreground);
}

._markdown-body :deep(a) {
  color: var(--color-primary);
  text-decoration: underline;
}

._markdown-body :deep(strong) {
  color: var(--color-foreground);
}

._markdown-body :deep(ul),
._markdown-body :deep(ol) {
  margin: 0.5em 0;
  padding-left: 1.5em;
  color: var(--color-foreground);
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
  border-left: 3px solid var(--color-element-hover);
  color: var(--color-foreground-low);
}

/*
 * code / pre / th の背景は地色に依存する。デフォルトは暗地 (zinc-900 系) 前提の zinc-800
 * だが、より明るい地 (チャット吹き出し等) に乗せると地より暗いブロックが浮く明度反転に
 * なる。consumer が `--md-code-bg` を渡せばその地に応じた背景に切り替わる (SSOT)。
 */
._markdown-body :deep(code) {
  padding: 0.15em 0.4em;
  border-radius: 3px;
  background: var(--md-code-bg, var(--color-panel));
  color: var(--color-foreground);
  font-size: 0.9em;
}

/*
 * インラインコードの長いトークン (絶対パス / URL 等) は折り返してコンテナ幅に収める。
 * 折り返さないと狭い吹き出しから背景がはみ出す。`box-decoration-break: clone` で
 * 折り返し後も各行が padding + 角丸を保ち、背景が行をまたいで割れないようにする。
 * `:not(pre) > code` でインラインのみ対象にし、pre 内コードは overflow-x スクロールを保つ。
 */
._markdown-body :deep(:not(pre) > code) {
  overflow-wrap: anywhere;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}

._markdown-body :deep(pre) {
  margin: 0.75em 0;
  padding: 1em;
  border-radius: 6px;
  background: var(--md-code-bg, var(--color-panel));
  overflow-x: auto;
  /*
   * ルートの overflow-wrap: anywhere の継承を断つ。コードブロックは折り返さず
   * overflow-x: auto で横スクロールさせる設計なので、root の anywhere が継承で効くと
   * (white-space を上書きする実装が将来入った場合に) 折り返しに倒れる余地を残す。
   * normal を明示して継承元の値に依存しない。
   */
  overflow-wrap: normal;
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
  border: 1px solid var(--color-element);
  color: var(--color-foreground);
}

._markdown-body :deep(th) {
  background: var(--md-code-bg, var(--color-panel));
  font-weight: 600;
  color: var(--color-foreground);
}

._markdown-body :deep(hr) {
  margin: 1.5em 0;
  border: none;
  border-top: 1px solid var(--color-element);
}

._markdown-body :deep(img) {
  max-width: 100%;
}
</style>
