<doc lang="md">
task title 編集 dialog。`useTaskEditing` の context (task + rootDir) が定義されたら開く。

## 構成

- title input: user_title の編集中バッファ。input を空にして Save すれば user_title を
  クリアでき、表示は gh_title / terminal_title の自然なフォールバックに戻る
- input placeholder: `fallbackTitle(task)` を動的バインドし、「Save 時に表示される値」を
  予告する (Reset 専用ボタンを置かない代わり)
- Sources セクション:
  - PR/Issue row: `task.ghTitle` (永続値) を表示 + `Use` で input にコピー
  - Terminal row: `task.terminalTitle` (live) を表示するだけ、ボタンなし
    (コピーしても陳腐化するだけなので意味がない)

## 設計判断

- user_title / gh_title / terminal_title は起源で分離されたフィールド。dialog では:
  - user_title 編集 → input
  - gh_title コピー → Use ボタン
  - terminal_title は live 観測値の参考表示
  - reset (user_title クリア) → input を空にして Save
- 保存 RPC は `rpcTaskSetUserTitle` 1 経路 (空文字も valid)。dialog UI が
  「コピー」「クリア」「自由入力」を draft 操作として吸収する
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { rpcTaskSetUserTitle } from "./rpc";
import { useTaskEditing } from "./useTaskEditing";
import { fallbackTitle } from "./utils";

const { context, close } = useTaskEditing();
const repoStore = useRepoStore();
const notify = useNotificationStore();

const dialogRef = ref<HTMLDialogElement | undefined>(undefined);
const inputRef = ref<HTMLInputElement | undefined>(undefined);
const draft = ref("");

const currentTask = computed(() => context.value?.task);
const currentRootDir = computed(() => context.value?.rootDir);

const ghRefLabel = computed<string>(() => {
  const task = currentTask.value;
  if (task?.ghRef === undefined) return "";
  // GhRefKind: 1=PR, 2=ISSUE
  return task.ghRef.kind === 1 ? `PR #${task.ghRef.number}` : `Issue #${task.ghRef.number}`;
});

const ghTitleValue = computed<string>(() => currentTask.value?.ghTitle ?? "");
const ghTitleDisplay = computed<string>(() =>
  ghTitleValue.value === "" ? "(empty)" : ghTitleValue.value,
);
const ghTitleValueClass = computed<string>(() =>
  ghTitleValue.value === "" ? "italic text-zinc-500" : "text-zinc-200",
);

const terminalTitleValue = computed<string>(() => currentTask.value?.terminalTitle ?? "");
const terminalTitleDisplay = computed<string>(() =>
  terminalTitleValue.value === "" ? "(empty)" : terminalTitleValue.value,
);
const terminalTitleValueClass = computed<string>(() =>
  terminalTitleValue.value === "" ? "italic text-zinc-500" : "text-zinc-200",
);

// input placeholder: input を空にしたら表示される予告タイトル。
// user_title が空の場合の表示優先度に従う (gh > terminal > "New session")。
const inputPlaceholder = computed<string>(() => {
  const task = currentTask.value;
  if (task === undefined) return "";
  return fallbackTitle(task);
});

watch(
  context,
  (next) => {
    if (next === undefined) {
      dialogRef.value?.close();
      return;
    }
    // user_title の現在保存値を初期値にする。空ならそのまま空 → placeholder が予告
    draft.value = next.task.userTitle;
    dialogRef.value?.showModal();
    queueMicrotask(() => {
      inputRef.value?.focus();
      inputRef.value?.select();
    });
  },
  { immediate: false },
);

async function save() {
  const task = currentTask.value;
  const rootDir = currentRootDir.value;
  if (task === undefined || rootDir === undefined) return;
  const next = draft.value;
  if (next === task.userTitle) {
    close();
    return;
  }
  const result = await tryCatch(
    rpcTaskSetUserTitle({ dir: rootDir, id: task.id, userTitle: next }),
  );
  if (!result.ok) {
    notify.error("Failed to save task title", result.error);
    return;
  }
  repoStore.requestRefresh(rootDir);
  close();
}

function cancel() {
  close();
}

// バックドロップクリックで close
function onDialogClick(event: MouseEvent) {
  if (event.target === dialogRef.value) close();
}
</script>

<template>
  <dialog
    ref="dialogRef"
    class="m-auto bg-transparent p-0 backdrop:bg-black/50"
    @click="onDialogClick"
    @close="close"
  >
    <div
      v-if="currentTask"
      class="w-[460px] space-y-4 rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-zinc-100 shadow-xl"
    >
      <h2 class="text-sm font-semibold">Edit task title</h2>

      <div class="space-y-1">
        <label class="text-xs text-zinc-400" for="task-title-input">Title</label>
        <input
          id="task-title-input"
          ref="inputRef"
          v-model="draft"
          type="text"
          aria-label="Task title"
          :placeholder="inputPlaceholder"
          class="w-full rounded-sm bg-zinc-800 px-2 py-1 text-sm text-zinc-100 ring-1 ring-zinc-700 outline-none placeholder:text-zinc-500 placeholder:italic focus:ring-blue-500"
          @keydown.enter.prevent="save"
          @keydown.escape.prevent="cancel"
        />
      </div>

      <!-- Sources: 各 source の現在値を参考表示するだけ。アクションは input に集約。
           PR title を流用したいユーザーはテキスト選択 → コピペで対応。 -->
      <div class="space-y-2">
        <p class="text-xs text-zinc-400">Sources</p>

        <div
          v-if="currentTask.ghRef !== undefined"
          class="grid grid-cols-[6rem_1fr] items-center gap-2"
        >
          <span class="text-xs text-zinc-500">{{ ghRefLabel }}</span>
          <span
            class="min-w-0 truncate text-xs select-text"
            :class="ghTitleValueClass"
            :title="ghTitleValue"
            >{{ ghTitleDisplay }}</span
          >
        </div>

        <div class="grid grid-cols-[6rem_1fr] items-center gap-2">
          <span class="text-xs text-zinc-500">Terminal</span>
          <span
            class="min-w-0 truncate text-xs select-text"
            :class="terminalTitleValueClass"
            :title="terminalTitleValue"
            >{{ terminalTitleDisplay }}</span
          >
        </div>
      </div>

      <div class="flex justify-end gap-2 pt-2">
        <button
          type="button"
          class="rounded-sm px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
          @click="cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          class="rounded-sm bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500"
          @click="save"
        >
          Save
        </button>
      </div>
    </div>
  </dialog>
</template>
