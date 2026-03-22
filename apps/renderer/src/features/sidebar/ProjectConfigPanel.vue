<doc lang="md">
サイドバー下部のプロジェクト設定パネル。
worktree 作成時にメインリポジトリからシンボリックリンクする対象パスを改行区切りで編集する。
</doc>

<script setup lang="ts">
import { onMounted, ref, useTemplateRef } from "vue";
import { useRpc } from "../../shared/rpc";

const { request } = useRpc();

const detailsRef = ref<HTMLDetailsElement>();
const textareaRef = useTemplateRef<HTMLTextAreaElement>("textarea");
const symlinksText = ref("");
const isSaving = ref(false);
const isDirty = ref(false);

/** 保存済みの値（dirty 判定用） */
let savedText = "";

async function load() {
  const config = await request.projectConfigLoad();
  const text = config.worktreeSymlinks?.join("\n") ?? "";
  symlinksText.value = text;
  savedText = text;
  isDirty.value = false;
}

function handleInput(value: string) {
  symlinksText.value = value;
  isDirty.value = value !== savedText;
}

async function save() {
  if (!isDirty.value) return;
  isSaving.value = true;
  const symlinks = symlinksText.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  await request.projectConfigSave({
    worktreeSymlinks: symlinks,
  });
  savedText = symlinksText.value;
  isDirty.value = false;
  isSaving.value = false;
  detailsRef.value?.removeAttribute("open");
}

function cancel() {
  symlinksText.value = savedText;
  isDirty.value = false;
  detailsRef.value?.removeAttribute("open");
}

function handleToggle() {
  if (detailsRef.value?.open) {
    void load();
    textareaRef.value?.focus();
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="border-t border-zinc-700/50 px-4 py-3">
    <details ref="detailsRef" @toggle="handleToggle">
      <summary
        class="flex cursor-pointer list-none items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 [&::-webkit-details-marker]:hidden"
      >
        <span
          class="icon-[lucide--chevron-right] size-4 shrink-0 transition-transform [[open]>&]:rotate-90"
        />
        <span class="icon-[lucide--link] size-3.5 shrink-0" />
        <span>Worktree symlinks</span>
      </summary>
      <div class="mx-2 mt-1 mb-2">
        <textarea
          ref="textarea"
          :value="symlinksText"
          class="w-full resize-none rounded-sm border border-zinc-600 bg-zinc-800 p-2 text-sm text-zinc-200 focus:border-blue-500 focus:outline-none"
          rows="4"
          placeholder=".claude&#10;.env.local"
          @input="handleInput(($event.target as HTMLTextAreaElement).value)"
          @keydown.escape="cancel"
        />
        <div class="mt-1 flex justify-end gap-1">
          <button
            class="rounded-sm px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
            @click="cancel"
          >
            Cancel
          </button>
          <button
            class="rounded-sm bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600"
            :disabled="!isDirty || isSaving"
            @click="save"
          >
            Save
          </button>
        </div>
      </div>
    </details>
  </div>
</template>
