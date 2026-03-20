<doc lang="md">
Todo のインライン編集 UI。TodoIconPicker + textarea + キャンセル/保存ボタンで構成される。
マウント時に textarea を自動フォーカスする。
</doc>

<script setup lang="ts">
import { onMounted, useTemplateRef } from "vue";
import { onEnterSubmit } from "./todo-utils";
import TodoIconPicker from "./TodoIconPicker.vue";

const body = defineModel<string>("body", { required: true });
const icon = defineModel<string>("icon");

defineProps<{
  placeholder?: string;
}>();

const emit = defineEmits<{
  submit: [];
  cancel: [];
  "update:icon": [value: string | undefined];
}>();

const textareaRef = useTemplateRef<HTMLTextAreaElement>("textarea");

onMounted(() => {
  textareaRef.value?.focus();
});
</script>

<template>
  <div class="mx-2 mt-1 mb-2">
    <TodoIconPicker v-model="icon" @update:model-value="emit('update:icon', $event)" />
    <textarea
      ref="textarea"
      v-model="body"
      class="w-full resize-none rounded-sm border border-zinc-600 bg-zinc-800 p-2 text-sm text-zinc-200 focus:border-blue-500 focus:outline-none"
      rows="4"
      :placeholder="placeholder"
      @keydown.enter="onEnterSubmit($event, () => emit('submit'))"
      @keydown.escape="emit('cancel')"
    />
    <div class="mt-1 flex justify-end gap-1">
      <button
        class="rounded-sm px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
        @click="emit('cancel')"
      >
        キャンセル
      </button>
      <button
        class="rounded-sm bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500"
        @click="emit('submit')"
      >
        保存
      </button>
    </div>
  </div>
</template>
