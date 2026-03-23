<doc lang="md">
Todo のインライン編集フォーム。テキスト入力 + 保存/キャンセルボタンを提供する。
マウント時に textarea を自動フォーカスする。

アイコン選択は TodoIconButton がリスト上で直接担当するため、このコンポーネントでは扱わない。
</doc>

<script setup lang="ts">
import { computed, onMounted, useTemplateRef } from "vue";

defineProps<{
  placeholder?: string;
}>();

const body = defineModel<string>("body", { required: true });

const emit = defineEmits<{
  save: [];
  cancel: [];
}>();

const isEmpty = computed(() => body.value.trim() === "");

const textareaRef = useTemplateRef<HTMLTextAreaElement>("textarea");

onMounted(() => {
  textareaRef.value?.focus();
});

/** IME 変換中でない Enter キーのみ発火するガード */
const IME_KEYCODE = 229;
function onEnterSubmit(e: KeyboardEvent) {
  // WKWebView では isComposing が false のまま keyCode 229 が送られる
  if (e.isComposing || e.keyCode === IME_KEYCODE || e.shiftKey) return;
  e.preventDefault();
  if (isEmpty.value) return;
  emit("save");
}
</script>

<template>
  <div class="mx-2 mt-1 mb-2">
    <textarea
      ref="textarea"
      v-model="body"
      class="w-full resize-none rounded-sm border border-zinc-600 bg-zinc-800 p-2 text-sm text-zinc-200 focus:border-blue-500 focus:outline-none"
      rows="4"
      :placeholder="placeholder"
      @keydown.enter="onEnterSubmit"
      @keydown.escape="emit('cancel')"
    />
    <div class="mt-1 flex justify-end gap-1">
      <button
        class="rounded-sm px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
        @click="emit('cancel')"
      >
        Cancel
      </button>
      <button
        class="rounded-sm bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600"
        :disabled="isEmpty"
        @click="emit('save')"
      >
        Save
      </button>
    </div>
  </div>
</template>
