<script setup lang="ts">
import { computed } from "vue";
import { usePopover } from "../../shared/popover";
import { FileActionMenuItems, getFileIconUrl } from "../filer";
import { useWorktreeStore } from "../worktree";
import { FileCommitDate } from "./features/commit-history";
import { useMarkdownHistoryStore } from "./features/markdown";
import IconLucideArrowLeft from "~icons/lucide/arrow-left";
import IconLucideArrowRight from "~icons/lucide/arrow-right";
import IconLucideEllipsisVertical from "~icons/lucide/ellipsis-vertical";
import IconLucideX from "~icons/lucide/x";
import IconMdiDockWindow from "~icons/mdi/dock-window";

const props = defineProps<{
  /** FileCommitDate に渡す props 束。enabled=false なら FileCommitDate は描画も fetch もしない */
  fileCommitDateProps: { dir: string; relPath: string; rev: string; enabled: boolean };
  /** working tree に実体があるときだけ解決される絶対パス。undefined ならボタン非描画 */
  openableAbsPath: string | undefined;
  /** undock 可能なコンテンツを表示中か。false なら undock ボタン非描画 */
  undockable: boolean;
}>();

const emit = defineEmits<{
  close: [];
  undock: [];
}>();

const worktreeStore = useWorktreeStore();
const markdownHistory = useMarkdownHistoryStore();

const selectedDisplayPath = computed(() => worktreeStore.selectedDisplayPath);

function fileName(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

const headerIconUrl = computed(() => {
  const path = selectedDisplayPath.value;
  if (path === undefined) return undefined;
  return getFileIconUrl(fileName(path));
});

type FileMenuContext = {
  /** ⋮ クリック時に snapshot した操作対象の絶対パス (working tree 実体) */
  absPath: string;
};

const {
  Popover: FileMenuPopover,
  context: fileMenuContext,
  toggle: toggleFileMenu,
  close: closeFileMenu,
} = usePopover<FileMenuContext>();

function onFileMenuClick(event: MouseEvent) {
  const path = props.openableAbsPath;
  if (path === undefined) return;
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  toggleFileMenu(target, { absPath: path });
}
</script>

<template>
  <div class="flex items-center gap-2 border-b border-border px-3 py-2">
    <!-- markdown preview 内部リンク履歴ナビ。履歴の有無でレイアウトが揺れないよう常時表示 -->
    <button
      type="button"
      class="shrink-0 text-foreground-low hover:text-foreground disabled:cursor-default disabled:text-foreground-muted disabled:hover:text-foreground-muted"
      :disabled="!markdownHistory.canGoBack"
      title="Go back"
      aria-label="Go back"
      @click="markdownHistory.goBack()"
    >
      <IconLucideArrowLeft class="size-4" />
    </button>
    <button
      type="button"
      class="shrink-0 text-foreground-low hover:text-foreground disabled:cursor-default disabled:text-foreground-muted disabled:hover:text-foreground-muted"
      :disabled="!markdownHistory.canGoForward"
      title="Go forward"
      aria-label="Go forward"
      @click="markdownHistory.goForward()"
    >
      <IconLucideArrowRight class="size-4" />
    </button>
    <template v-if="selectedDisplayPath">
      <img :src="headerIconUrl" class="size-4 shrink-0" alt="" />
      <span class="truncate text-sm text-foreground" :title="selectedDisplayPath">{{
        fileName(selectedDisplayPath)
      }}</span>
      <FileCommitDate v-bind="fileCommitDateProps" />
    </template>
    <span v-else class="text-sm text-foreground-low">Preview</span>

    <div class="ml-auto flex shrink-0 items-center gap-1">
      <button
        v-if="undockable"
        type="button"
        class="text-foreground-low hover:text-foreground"
        title="Undock into floating window"
        aria-label="Undock"
        @click="emit('undock')"
      >
        <IconMdiDockWindow class="size-4" />
      </button>
      <button
        v-if="openableAbsPath"
        type="button"
        class="text-foreground-low hover:text-foreground"
        title="File actions"
        aria-label="File actions"
        @click="onFileMenuClick"
      >
        <IconLucideEllipsisVertical class="size-4" />
      </button>
      <button
        type="button"
        class="text-foreground-low hover:text-foreground"
        title="Close preview"
        aria-label="Close preview"
        @click="emit('close')"
      >
        <IconLucideX class="size-4" />
      </button>
    </div>

    <!-- ファイル操作メニュー。ヘッダ右端が anchor のため inline-start (左) 方向へ展開する -->
    <FileMenuPopover
      class="m-0 min-w-36 rounded-lg border border-border bg-background py-1 text-sm text-foreground shadow-lg"
      :style="{
        position: 'fixed',
        positionArea: 'block-end span-inline-start',
        positionTryFallbacks: 'flip-block, flip-inline, flip-block flip-inline',
      }"
    >
      <FileActionMenuItems
        v-if="fileMenuContext"
        :abs-path="fileMenuContext.absPath"
        :display-name="fileName(fileMenuContext.absPath)"
        :openable="true"
        @close="closeFileMenu()"
      />
    </FileMenuPopover>
  </div>
</template>
