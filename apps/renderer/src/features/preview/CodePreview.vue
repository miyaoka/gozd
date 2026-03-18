<doc lang="md">
Shiki によるシンタックスハイライト付きコード表示。

- 非同期ハイライト完了までは行番号付きプレーンテキストをフォールバック表示
- バージョンカウンターで非同期レースを防止
</doc>

<script setup lang="ts">
import { watch, ref, nextTick } from "vue";
import { highlight } from "./useHighlight";

const props = defineProps<{
  content: string;
  filePath: string;
  /** スクロール・ハイライト対象の行番号（1-based） */
  lineNumber?: number;
  /** 同一パス・同一行番号でもスクロールを再発火させるためのカウンタ */
  revealVersion: number;
  wordWrap: boolean;
}>();

const highlightedHtml = ref<string>();
const containerRef = ref<HTMLElement>();
const activeLineNumber = ref<number>();

/** 非同期レース防止用のバージョンカウンター */
let highlightVersion = 0;

const ACTIVE_LINE_CLASS = "_active-line";

/** 前回のハイライトをクリアする */
function clearActiveHighlight() {
  const container = containerRef.value;
  if (!container) return;
  const prev = container.querySelector(`.${ACTIVE_LINE_CLASS}`);
  if (prev) prev.classList.remove(ACTIVE_LINE_CLASS);
}

/** 指定行までスクロールしてハイライトする */
async function scrollToLine(line: number) {
  activeLineNumber.value = line;
  await nextTick();
  const container = containerRef.value;
  if (!container) return;

  clearActiveHighlight();

  const lineEl = container.querySelector(`[data-line="${line}"]`);
  if (!lineEl) return;

  lineEl.classList.add(ACTIVE_LINE_CLASS);
  lineEl.scrollIntoView({ block: "center" });
}

watch(
  () => [props.content, props.filePath],
  () => {
    highlightedHtml.value = undefined;
    activeLineNumber.value = undefined;
    const version = ++highlightVersion;
    highlight(props.content, props.filePath).then((html) => {
      if (version !== highlightVersion) return;
      // html が undefined の場合はフォールバック表示（Shiki 未対応言語）
      if (html) {
        highlightedHtml.value = html;
      }
      if (props.lineNumber !== undefined) {
        void scrollToLine(props.lineNumber);
      }
    });
  },
  { immediate: true },
);

/** selectPath のたびにスクロールを再発火（同一パス・同一行番号でも対応） */
watch(
  () => props.revealVersion,
  () => {
    if (props.lineNumber !== undefined) {
      void scrollToLine(props.lineNumber);
    } else {
      clearActiveHighlight();
      activeLineNumber.value = undefined;
    }
  },
);
</script>

<template>
  <!-- ハイライト済み HTML -->
  <div
    v-if="highlightedHtml"
    ref="containerRef"
    class="_highlighted-code text-sm/tight"
    :class="wordWrap ? '_word-wrap' : ''"
    v-html="highlightedHtml"
  />

  <!-- フォールバック: プレーンテキスト -->
  <pre
    v-else
    ref="containerRef"
    class="_line-numbered p-4 text-sm/tight text-zinc-300"
    :class="wordWrap ? '_word-wrap break-all whitespace-pre-wrap' : ''"
  ><code><span
        v-for="(line, i) in content.split('\n')"
        :key="i"
        class="_line"
        :data-line="i + 1"
      >{{ line }}
</span></code></pre>
</template>

<style scoped>
._line-numbered ._line::before,
._highlighted-code :deep(.line::before) {
  content: attr(data-line);
  display: inline-block;
  width: 3ch;
  margin-right: 1.5ch;
  text-align: right;
  color: var(--color-zinc-600);
  user-select: none;
}

/* 折り返し時: 行番号を absolute で固定し、折り返し行が行番号の右側に揃うよう padding で確保 */
._line-numbered._word-wrap ._line,
._highlighted-code._word-wrap :deep(.line) {
  position: relative;
  display: block;
  padding-left: 4.5ch;
  min-height: 1lh;
}

._line-numbered._word-wrap ._line::before,
._highlighted-code._word-wrap :deep(.line::before) {
  position: absolute;
  left: 0;
  margin-right: 0;
}

._highlighted-code :deep(pre) {
  padding: 1rem;
  margin: 0;
  background: transparent !important;
}

._highlighted-code._word-wrap :deep(pre) {
  white-space: pre-wrap;
  word-break: break-all;
}

._highlighted-code :deep(code) {
  font-family: inherit;
}

._highlighted-code._word-wrap :deep(code) {
  display: flex;
  flex-direction: column;
}

/* アクティブ行のハイライト（scrollToLine が直接クラスを付与） */
._line-numbered ._line._active-line,
._highlighted-code :deep(.line._active-line) {
  background-color: color-mix(in oklch, var(--color-yellow-500) 15%, transparent);
}
</style>
