<doc lang="md">
サイドバー下部のプロジェクト設定パネル。
worktree 作成時にメインリポジトリからシンボリックリンクする対象パスを改行区切りで編集する。
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { onMounted, ref, useTemplateRef } from "vue";
import { rpcProjectConfigLoad, rpcProjectConfigSave } from "../settings";
import { useWorktreeStore } from "../worktree";

const worktreeStore = useWorktreeStore();

const detailsRef = ref<HTMLDetailsElement>();
const textareaRef = useTemplateRef<HTMLTextAreaElement>("textarea");
const symlinksText = ref("");
const isSaving = ref(false);
const isDirty = ref(false);

/** 保存済みの値（dirty 判定用） */
let savedText = "";

async function load() {
  const dir = worktreeStore.dir;
  if (dir === undefined) return;
  const result = await tryCatch(rpcProjectConfigLoad({ dir }));
  if (!result.ok) return;
  const text = result.value.config?.worktreeSymlinks.join("\n") ?? "";
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
  const dir = worktreeStore.dir;
  if (dir === undefined) return;
  isSaving.value = true;
  const symlinks = symlinksText.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const result = await tryCatch(rpcProjectConfigSave(dir, { worktreeSymlinks: symlinks }));
  isSaving.value = false;
  if (!result.ok) return;
  savedText = symlinksText.value;
  isDirty.value = false;
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
  <div class="border-t border-border/50 px-4 py-3">
    <details ref="detailsRef" @toggle="handleToggle">
      <summary
        class="flex cursor-pointer list-none items-center gap-2 text-xs text-foreground-low hover:text-foreground [&::-webkit-details-marker]:hidden"
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
          class="w-full resize-none rounded-sm border border-border-strong bg-panel p-2 text-sm text-foreground focus:border-primary focus:outline-none"
          rows="4"
          placeholder=".claude&#10;.env.local"
          @input="handleInput(($event.target as HTMLTextAreaElement).value)"
          @keydown.escape="cancel"
        />
        <div class="mt-1 flex justify-end gap-1">
          <button
            class="rounded-sm px-2 py-1 text-xs text-foreground-low hover:bg-panel"
            @click="cancel"
          >
            Cancel
          </button>
          <button
            class="rounded-sm bg-primary px-2 py-1 text-xs text-foreground hover:bg-primary disabled:opacity-40 disabled:hover:bg-primary"
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
