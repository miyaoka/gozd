<doc lang="md">
Preview の Current タブ編集用エディタ。Monaco Editor (`monacoSetup.ts`) を使い、シンタックス
ハイライトを保ったまま編集できる。

## 言語判定

Monaco 自身が保持する言語登録メタデータ (`monaco.languages.getLanguages()` の
`extensions` / `filenames`) から逆引きする。Shiki 用の `@gozd/shiki-lang-map` とは別の
SSOT (Monaco 上での編集にのみ関係するため、Shiki 側の拡張子マップに寄せる必要はない)。
</doc>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { monaco } from "./monacoSetup";
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
let editor: monaco.editor.IStandaloneCodeEditor | undefined;

function detectLanguage(filePath: string): string {
  const fileName = filePath.split("/").pop() ?? filePath;
  const ext = `.${fileName.split(".").pop() ?? ""}`;
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.includes(fileName)) return lang.id;
    if (lang.extensions?.includes(ext)) return lang.id;
  }
  return "plaintext";
}

onMounted(() => {
  const el = containerRef.value;
  if (el === undefined) return;
  editor = monaco.editor.create(el, {
    value: props.modelValue,
    language: detectLanguage(props.filePath),
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
</script>

<template>
  <div ref="containerRef" class="size-full" aria-label="Edit file contents" />
</template>
