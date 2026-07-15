<doc lang="md">
ファイル操作メニューの共通項目 (Open in default app / Copy file / Copy path)。
Filer / Changes の右クリックメニュー (navigator の FileContextMenu) と preview ヘッダの
⋮ メニューが同じ項目セットを共有するための slot content。popover は持たず、呼び出し側の
Popover 内に置き `@close` で親に閉じさせる (`usePopover` の「menu の種類ごとに独立した
popover を作り 1 instance に統合しない」規律に従い、共有するのは項目とアクションだけにする)。

Open / Copy file は `openable` (working tree に実体がある) のときだけ出す。snapshot 表示中の
ファイルはディスク上に実体が無く、項目を出すと最新の worktree 内容が開かれる / paste される
誤読を生むため。メニューは可視 UI なので「出さない」こと自体が説明になり、toast による
拒否通知 (キーボード経路 `filer.copyFile` の担当) は不要。Copy path は実体の有無と無関係に
成立するため常に出す。
</doc>

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
