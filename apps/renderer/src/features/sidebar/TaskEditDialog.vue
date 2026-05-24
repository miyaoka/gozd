<doc lang="md">
task title 編集 dialog。`useTaskEditing` の context (`taskId` + `rootDir`) が定義されたら開く。

## 構成

- title input: user_title の編集中バッファ
- input placeholder: `placeholderForEmptyUserTitle(task)` を動的バインド。Save 時に
  表示される値 (`taskDisplayTitle({ ...task, userTitle: "" })` 相当) をそのまま予告
- Sources セクション: `ghTitle` / `terminalTitle` の現在値を参考表示するだけ
  (操作なし、選択可能テキストでコピペ可)

## 設計判断

- `useTaskEditing` からは taskId のみ受け取り、Task オブジェクトは `useRepoStore` から
  computed で引き直す。dialog open 中の OSC タイトル更新や fetchRepo で Task identity が
  差し替わっても Sources 表示が live で追従する
- 保存 RPC は `rpcTaskSetUserTitle` 1 経路。空文字保存 = `user_title` クリア = フォール
  バックチェーン復帰。input 操作 1 個に「コピー」「クリア」「自由入力」を集約する
- whitespace-only 入力は save 時に `trim()` して空文字に正規化し、見た目空 / 実体非空の
  解離を防ぐ
- ghRef の表示ラベルは `ghRefLabel` (`@gozd/proto` ヘルパー) を使い、`kind === 1` の
  ような magic number 比較を排除
</doc>

<script setup lang="ts">
import { ghRefLabel } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { rpcTaskSetUserTitle } from "./rpc";
import { useTaskEditing } from "./useTaskEditing";
import { placeholderForEmptyUserTitle } from "./utils";

const { context, close } = useTaskEditing();
const repoStore = useRepoStore();
const notify = useNotificationStore();

const dialogRef = ref<HTMLDialogElement | undefined>(undefined);
const inputRef = ref<HTMLInputElement | undefined>(undefined);
const draft = ref("");

// store から最新 Task を都度引き直す。open 中に Task identity が差し替わっても
// Sources 行が live で更新される。Task が消えたら自動 close。
const currentTask = computed(() => {
  const ctx = context.value;
  if (ctx === undefined) return undefined;
  const repo = repoStore.repos[ctx.rootDir];
  if (repo === undefined) return undefined;
  for (const wt of repo.worktrees) {
    const found = wt.tasks.find((t) => t.id === ctx.taskId);
    if (found !== undefined) return found;
  }
  return undefined;
});
const currentRootDir = computed(() => context.value?.rootDir);

// open 中に Task が永続化から消えたら dialog を閉じる
watch(currentTask, (task) => {
  if (context.value !== undefined && task === undefined) close();
});

const ghRefLabelText = computed<string>(() => {
  const task = currentTask.value;
  if (task?.ghRef === undefined) return "";
  return ghRefLabel(task.ghRef);
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

// input placeholder: input を空にしたら表示される予告タイトル (Save 結果と一致)
const inputPlaceholder = computed<string>(() => {
  const task = currentTask.value;
  if (task === undefined) return "";
  return placeholderForEmptyUserTitle(task);
});

watch(
  context,
  (next) => {
    if (next === undefined) {
      dialogRef.value?.close();
      return;
    }
    // user_title の現在保存値を初期値にする。空ならそのまま空 → placeholder が予告
    draft.value = currentTask.value?.userTitle ?? "";
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
  // whitespace-only は空文字 = reset として正規化。「見た目空 / 実体非空」の解離を防ぐ
  const next = draft.value.trim();
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

      <div class="space-y-2">
        <p class="text-xs text-zinc-400">Sources</p>

        <div
          v-if="currentTask.ghRef !== undefined"
          class="grid grid-cols-[6rem_1fr] items-center gap-2"
        >
          <span class="text-xs text-zinc-500">{{ ghRefLabelText }}</span>
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
