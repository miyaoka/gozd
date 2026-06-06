<doc lang="md">
Shiki によるシンタックスハイライト付きコード表示。

- 非同期ハイライト完了までは行番号付きプレーンテキストをフォールバック表示
- onCleanup で非同期レースを防止
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { watch, ref, nextTick, computed } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { highlight } from "./useHighlight";

const notification = useNotificationStore();

const props = withDefaults(
  defineProps<{
    content: string;
    filePath: string;
    /** スクロール・ハイライト対象の行番号（1-based） */
    lineNumber?: number;
    /** 同一パス・同一行番号でもスクロールを再発火させるためのカウンタ */
    revealVersion: number;
    wordWrap: boolean;
    /**
     * 行番号を blame ボタンとして描画するか。false なら静的な表示に倒し、
     * hover も cursor:pointer も出さない (silent dead button を避ける契約)。
     */
    blameEnabled?: boolean;
  }>(),
  { blameEnabled: false },
);

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
  () => [props.content, props.filePath, props.blameEnabled],
  async (_, __, onCleanup) => {
    highlightedHtml.value = undefined;
    activeLineNumber.value = undefined;

    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });

    const result = await tryCatch(highlight(props.content, props.filePath, props.blameEnabled));
    if (cancelled) return;
    if (!result.ok) {
      // `highlight` は言語不明を undefined で正常返却する (useHighlight.ts)。
      // ここで tryCatch が捕捉するのは Shiki の grammar load 失敗や予期しない例外で、
      // map 拡大後は on-demand load 経路で起こりうる。silent fallback すると原因を
      // 追えないため error として通知する (renderer 規約: silent fallback 禁止、
      // DiffPreview と同じ契約)。
      notification.error("Syntax highlight failed", result.error);
      return;
    }

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
 * `closest` で 1 経路に統一する。`blameEnabled` が false のときは早期 return し、
 * CSS でも cursor:pointer / hover styling を抑制して「クリックしても何も起きない
 * ボタン」を作らない契約 (silent dead button 禁止)。
 */
function onContainerClick(e: MouseEvent) {
  if (!props.blameEnabled) return;
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const btn = target.closest("[data-line-no-btn]");
  if (!(btn instanceof HTMLElement)) return;
  const lineStr = btn.dataset.lineNoBtn;
  if (lineStr === undefined) return;
  const line = Number(lineStr);
  if (!Number.isInteger(line) || line <= 0) return;
  // preventDefault は button の form submit / focus 移動の副作用を抑えるため。
  // stopPropagation はしない: 親 (PreviewPane / 上位 layout) で将来 click delegation
  // を仕掛けたい場合に潰さない方針。close() の Popover API トグルは別経路。
  e.preventDefault();
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
    class="_line-numbered p-4 text-sm/tight text-foreground"
    :class="wordWrap ? '_word-wrap break-all whitespace-pre-wrap' : ''"
    :style="{ '--line-no-width': lineNoWidth }"
    @click="onContainerClick"
  ><code><span
        v-for="(line, i) in content.split('\n')"
        :key="i"
        class="_line"
        :data-line="i + 1"
      ><button
          v-if="blameEnabled"
          type="button"
          class="_line-no-btn"
          :data-line-no-btn="i + 1"
        >{{ i + 1 }}</button><span
          v-else
          class="_line-no-static"
          aria-hidden="true"
        >{{ i + 1 }}</span>{{ line }}
</span></code></pre>
</template>

<style scoped>
/* blame ON: `<button data-line-no-btn>` (Shiki / fallback どちらも同形) */
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
  color: var(--color-border-strong);
  user-select: none;
  cursor: pointer;
}

._line-numbered ._line ._line-no-btn:hover,
._highlighted-code :deep(.line ._line-no-btn:hover) {
  color: var(--color-info);
  text-decoration: underline;
}

/* keyboard focus 可視化。silent dead button 禁止規約の延長で、Tab 到達した button が
   視認できることを担保する。outline は info token と整合させる */
._line-numbered ._line ._line-no-btn:focus-visible,
._highlighted-code :deep(.line ._line-no-btn:focus-visible) {
  outline: 2px solid var(--color-info);
  outline-offset: -2px;
  color: var(--color-info);
}

/* blame OFF: `<span class="_line-no-static">`。focusable を奪うため span に倒す。
   silent dead button 禁止規約: keyboard 経路 (Tab + Enter) でも何も起きないことを構造で保証する */
._line-numbered ._line ._line-no-static,
._highlighted-code :deep(.line ._line-no-static) {
  display: inline-block;
  width: var(--line-no-width, 3ch);
  margin-right: 1.5ch;
  text-align: right;
  color: var(--color-border-strong);
  user-select: none;
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
._highlighted-code._word-wrap :deep(.line ._line-no-btn),
._line-numbered._word-wrap ._line ._line-no-static,
._highlighted-code._word-wrap :deep(.line ._line-no-static) {
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
  background-color: color-mix(in oklch, var(--color-warning) 15%, transparent);
}
</style>
