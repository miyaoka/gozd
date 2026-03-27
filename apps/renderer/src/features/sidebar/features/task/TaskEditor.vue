<doc lang="md">
Task のインライン編集フォーム。テキスト入力 + 保存/キャンセルボタンを提供する。
マウント時に textarea を自動フォーカスする。
</doc>

<script setup lang="ts">
import { computed, onMounted, useTemplateRef } from "vue";
import { isIMEActive } from "../../../../shared/command";

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
function onEnterSubmit(e: KeyboardEvent) {
  if (isIMEActive(e) || e.shiftKey) return;
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
