<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { writeClipboardText } from "../../shared/clipboard";
import { useNotificationStore } from "../../shared/notification";
import { copyFileToOsClipboard } from "./copyFileToOsClipboard";
import { rpcOpenFile } from "./rpc";
import IconLucideExternalLink from "~icons/lucide/external-link";
import IconLucideFiles from "~icons/lucide/files";
import IconLucideFolderTree from "~icons/lucide/folder-tree";

const props = defineProps<{
  /** 操作対象の絶対パス (Open / Copy file の対象、Copy path のテキスト) */
  absPath: string;
  /** Copy file 成功 toast に出す表示名 */
  displayName: string;
  /** Copy path で absPath の前行に付ける commit hash。undefined なら絶対パスのみ */
  commitHash?: string;
  /** working tree に実体があるか。false なら Open / Copy file を出さない */
  openable: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();

const notify = useNotificationStore();

// 各 handler は props を同期 snapshot してから close を emit する。close 後に親側で
// context が undefined に倒れて本コンポーネントが unmount されても、実行中の async
// アクションは snapshot 済みの値で完走する。

async function handleOpen() {
  const { absPath } = props;
  emit("close");
  const result = await tryCatch(rpcOpenFile({ path: absPath }));
  if (!result.ok) {
    notify.error(`Failed to open file: ${absPath}`, result.error);
  }
}

async function handleCopyFile() {
  const { absPath, displayName } = props;
  emit("close");
  await copyFileToOsClipboard(absPath, displayName);
}

async function handleCopyPath() {
  const { absPath, commitHash } = props;
  const text = commitHash === undefined ? absPath : `${commitHash}\n${absPath}`;
  emit("close");
  const result = await writeClipboardText(text);
  if (!result.ok) {
    notify.error("Failed to copy path", result.error);
  }
}
</script>

<template>
  <button
    v-if="openable"
    class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel"
    @click="handleOpen"
  >
    <IconLucideExternalLink class="size-4 shrink-0" />
    Open in default app
  </button>
  <button
    v-if="openable"
    class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel"
    @click="handleCopyFile"
  >
    <IconLucideFiles class="size-4 shrink-0" />
    Copy file
  </button>
  <button
    class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel"
    @click="handleCopyPath"
  >
    <IconLucideFolderTree class="size-4 shrink-0" />
    Copy path
  </button>
</template>
