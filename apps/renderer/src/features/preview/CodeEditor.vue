<doc lang="md">
Preview の Current タブ編集用エディタ。Monaco Editor (`monacoSetup.ts`) を使い、シンタックス
ハイライトを保ったまま編集できる。

## 言語判定とハイライト

`monacoSetup.ts` の `resolveMonacoLanguage` で解決する。CodePreview (readonly 表示) と同じ
Shiki ベースの判定 + TextMate ハイライトになるため、閲覧 ↔ 編集の切替でハイライトが変わらない。

## 遅延ロード

`monaco-editor` は全言語入りの重量パッケージ (`monacoSetup.ts` 参照) のため、`onMounted` 内で
`import("./monacoSetup")` する。

## blame

CodePreview と同じ gutter クリック → `lineNumberClick` を配線する (`monacoSetup.ts` の
`wireGutterLineClick`)。閲覧と編集で見た目が同一 (どちらも Monaco) のため、片方だけ gutter が
反応しない非対称を作らない。blame の対象は保存済みの working tree ファイルであり、未保存の
draft で行がずれていると blame 行と表示行が一致しないことがある (git は on-disk の内容しか
読めない)。draft の変更で popover は閉じる (`usePreviewRevs`)。
</doc>

<script setup lang="ts">
import type * as Monaco from "monaco-editor";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { previewCodeFontFamily, previewFontSize } from "./previewConfig";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    filePath: string;
    wordWrap: boolean;
    /** 行番号を blame ボタンとして扱うか (CodePreview と同じ契約) */
    blameEnabled?: boolean;
  }>(),
  { blameEnabled: false },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  cancel: [];
  /** 行番号クリック。anchorEl は popover anchor 用、line は 1-based の表示行 */
  lineNumberClick: [payload: { line: number; anchorEl: HTMLElement }];
  /** エディタのスクロール。blame anchor がクリック時の位置に固定のため親は popover を閉じる */
  scrolled: [];
}>();

const containerRef = ref<HTMLElement>();
/** blame popover の anchor (自前所有の固定要素。monacoSetup の wireGutterLineClick が位置決め) */
const blameAnchorRef = ref<HTMLElement>();
let editor: Monaco.editor.IStandaloneCodeEditor | undefined;

onMounted(async () => {
  const el = containerRef.value;
  if (el === undefined) return;
  const { monaco, MONACO_THEME, resolveMonacoLanguage, wireGutterLineClick } =
    await import("./monacoSetup");
  const language = await resolveMonacoLanguage(props.filePath);
  // await 中に unmount された場合、containerRef は Vue によって undefined に戻される。
  if (containerRef.value !== el) return;
  editor = monaco.editor.create(el, {
    value: props.modelValue,
    language,
    theme: MONACO_THEME,
    automaticLayout: true,
    minimap: { enabled: false },
    fontFamily: previewCodeFontFamily.value || undefined,
    // CodePreview (readonly 表示) と同じ指定にし、閲覧 ↔ 編集切替で文字サイズが跳ねないようにする
    fontSize: previewFontSize.value > 0 ? previewFontSize.value : undefined,
    wordWrap: props.wordWrap ? "on" : "off",
    scrollBeyondLastLine: false,
  });
  editor.onDidChangeModelContent(() => {
    emit("update:modelValue", editor?.getValue() ?? "");
  });
  // gutter クリック → blame 起動。判定と anchor 配置の設計判断は wireGutterLineClick の
  // docstring (monacoSetup.ts) を参照。
  wireGutterLineClick(
    editor,
    () => blameAnchorRef.value,
    () => props.blameEnabled,
    (payload) => emit("lineNumberClick", payload),
  );
  editor.onDidScrollChange(() => emit("scrolled"));
  // MainLayout のグローバル ESC (preview を閉じる) は e.defaultPrevented を見て早期 return する。
  // Monaco の addCommand は内部で preventDefault / stopPropagation するため、suggestion widget /
  // find widget が開いていないときだけ「編集キャンセル」に倒し、2 回目の ESC で初めて preview が閉じる。
  editor.addCommand(
    monaco.KeyCode.Escape,
    () => emit("cancel"),
    "!suggestWidgetVisible && !findWidgetVisible && !renameInputVisible",
  );
  editor.focus();
});

onUnmounted(() => {
  editor?.dispose();
});

watch(
  () => props.wordWrap,
  (wrap) => {
    editor?.updateOptions({ wordWrap: wrap ? "on" : "off" });
  },
);

/**
 * Discard 等、外部（editStore.draftContent）からの内容変更を Monaco に反映する。
 * `editor.getValue() !== val` の等値チェックが、この watch 自身が発火させた
 * `update:modelValue` → 親の `updateDraft` → 同じ値の modelValue という feedback loop を止める。
 */
watch(
  () => props.modelValue,
  (val) => {
    if (editor !== undefined && editor.getValue() !== val) editor.setValue(val);
  },
);
</script>

<template>
  <div class="relative size-full">
    <div
      ref="containerRef"
      class="size-full"
      :class="blameEnabled ? '_blame-gutter' : ''"
      aria-label="Edit file contents"
    />

    <!-- blame popover の anchor。CodePreview と同じ契約 (wireGutterLineClick の docstring 参照) -->
    <div ref="blameAnchorRef" class="pointer-events-none absolute" aria-hidden="true" />
  </div>
</template>

<style scoped>
/* blame ON のときだけ gutter の行番号をクリック可能に見せる (CodePreview と同じ契約) */
._blame-gutter :deep(.margin-view-overlays .line-numbers) {
  cursor: pointer;
}

._blame-gutter :deep(.margin-view-overlays .line-numbers:hover) {
  color: var(--color-primary);
  text-decoration: underline;
}
</style>
