<doc lang="md">
Shiki によるシンタックスハイライト付きコード表示。

- 非同期ハイライト完了までは行番号付きプレーンテキストをフォールバック表示
- onCleanup で非同期レースを防止
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { watch, ref, nextTick, computed } from "vue";
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

const emit = defineEmits<{
  /** 行番号クリック。anchorEl は popover anchor 用、line は 1-based の表示行 */
  lineNumberClick: [payload: { line: number; anchorEl: HTMLElement }];
}>();

const highlightedHtml = ref<string>();
const containerRef = ref<HTMLElement>();
const activeLineNumber = ref<number>();

const ACTIVE_LINE_CLASS = "_active-line";

/** 行数の桁数（CSS カスタムプロパティ --line-no-width に使用） */
const lineCount = computed(() => props.content.split("\n").length);
const lineNoWidth = computed(() => `${String(lineCount.value).length}ch`);

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
  async (_, __, onCleanup) => {
    highlightedHtml.value = undefined;
    activeLineNumber.value = undefined;

    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });

    const result = await tryCatch(highlight(props.content, props.filePath));
    if (cancelled || !result.ok) return;

    // result.value が undefined の場合はフォールバック表示（Shiki 未対応言語）
    if (result.value) {
      highlightedHtml.value = result.value;
    }
    if (props.lineNumber !== undefined) {
      void scrollToLine(props.lineNumber);
    }
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

/**
 * 行番号ボタンの click をコンテナ delegation で拾う。
 * Shiki / fallback どちらも `[data-line-no-btn]` 属性付きの button を持つので、
 * `closest` で 1 経路に統一する。
 */
function onContainerClick(e: MouseEvent) {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const btn = target.closest("[data-line-no-btn]");
  if (!(btn instanceof HTMLElement)) return;
  const lineStr = btn.dataset.lineNoBtn;
  if (lineStr === undefined) return;
  const line = Number(lineStr);
  if (!Number.isInteger(line) || line <= 0) return;
  e.preventDefault();
  e.stopPropagation();
  emit("lineNumberClick", { line, anchorEl: btn });
}
</script>

<template>
  <!-- ハイライト済み HTML -->
  <div
    v-if="highlightedHtml"
    ref="containerRef"
    class="_highlighted-code text-sm/tight"
    :class="wordWrap ? '_word-wrap' : ''"
    :style="{ '--line-no-width': lineNoWidth }"
    v-html="highlightedHtml"
    @click="onContainerClick"
  />

  <!-- フォールバック: プレーンテキスト -->
  <pre
    v-else
    ref="containerRef"
    class="_line-numbered p-4 text-sm/tight text-zinc-300"
    :class="wordWrap ? '_word-wrap break-all whitespace-pre-wrap' : ''"
    :style="{ '--line-no-width': lineNoWidth }"
    @click="onContainerClick"
  ><code><span
        v-for="(line, i) in content.split('\n')"
        :key="i"
        class="_line"
        :data-line="i + 1"
      ><button
          type="button"
          class="_line-no-btn"
          :data-line-no-btn="i + 1"
        >{{ i + 1 }}</button>{{ line }}
</span></code></pre>
</template>

<style scoped>
._line-numbered ._line ._line-no-btn,
._highlighted-code :deep(.line ._line-no-btn) {
  display: inline-block;
  width: var(--line-no-width, 3ch);
  margin-right: 1.5ch;
  padding: 0;
  background: transparent;
  border: none;
  text-align: right;
  font: inherit;
  color: var(--color-zinc-600);
  user-select: none;
  cursor: pointer;
}

._line-numbered ._line ._line-no-btn:hover,
._highlighted-code :deep(.line ._line-no-btn:hover) {
  color: var(--color-blue-400);
  text-decoration: underline;
}

/* 折り返し時: 行番号を absolute で固定し、折り返し行が行番号の右側に揃うよう padding で確保 */
._line-numbered._word-wrap ._line,
._highlighted-code._word-wrap :deep(.line) {
  position: relative;
  display: block;
  padding-left: calc(var(--line-no-width, 3ch) + 1.5ch);
  min-height: 1lh;
}

._line-numbered._word-wrap ._line ._line-no-btn,
._highlighted-code._word-wrap :deep(.line ._line-no-btn) {
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
