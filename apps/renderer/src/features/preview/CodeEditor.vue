<doc lang="md">
Preview の Current タブ編集用エディタ。Monaco Editor (`monacoSetup.ts`) を使い、シンタックス
ハイライトを保ったまま編集できる。

## 言語判定

Monaco 自身が保持する言語登録メタデータ (`monaco.languages.getLanguages()` の
`extensions` / `filenames`) から逆引きする (`monacoSetup.ts` の `detectMonacoLanguage`)。
Shiki 用の `@gozd/shiki-lang-map` とは別の SSOT (Monaco 上での編集にのみ関係するため、
Shiki 側の拡張子マップに寄せる必要はない)。

## 遅延ロード

`monaco-editor` は全言語入りの重量パッケージ (`monacoSetup.ts` 参照) のため、`onMounted` 内で
`import("./monacoSetup")` する。閲覧のみ (編集モードに入らない) ユーザーはロードしない。
</doc>

<script setup lang="ts">
import type * as Monaco from "monaco-editor";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { previewCodeFontFamily } from "./previewConfig";

const props = defineProps<{
  modelValue: string;
  filePath: string;
  wordWrap: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  cancel: [];
}>();

const containerRef = ref<HTMLElement>();
let editor: Monaco.editor.IStandaloneCodeEditor | undefined;

onMounted(async () => {
  const el = containerRef.value;
  if (el === undefined) return;
  const { monaco, detectMonacoLanguage } = await import("./monacoSetup");
  // await 中に unmount された場合、containerRef は Vue によって undefined に戻される。
  if (containerRef.value !== el) return;
  editor = monaco.editor.create(el, {
    value: props.modelValue,
    language: detectMonacoLanguage(props.filePath),
    theme: "vs-dark",
    automaticLayout: true,
    minimap: { enabled: false },
    fontFamily: previewCodeFontFamily.value || undefined,
    wordWrap: props.wordWrap ? "on" : "off",
    scrollBeyondLastLine: false,
  });
  editor.onDidChangeModelContent(() => {
    emit("update:modelValue", editor?.getValue() ?? "");
  });
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
  <div ref="containerRef" class="size-full" aria-label="Edit file contents" />
</template>
