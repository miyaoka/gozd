<doc lang="md">
Preview popover のヘッダ行。markdown 内部リンク履歴の back / forward、ファイル名 +
コミット日 (FileCommitDate)、「デフォルトアプリで開く」/ close ボタンを持つ。

- back / forward は履歴の有無で header の幅が揺れないよう常時描画し、`canGoBack` /
  `canGoForward` が false の側は `disabled` 属性 + `disabled:text-foreground-muted` で見た目だけ
  落とす (Primer "NEVER use opacity for disabled" 規律に従い solid token を使う)
- open ボタンは `openableAbsPath` (working tree に実体があるときだけ解決される実パス) を prop で
  受け、`v-if` で描画自体を gate して silent dead button を作らない
- 「デフォルトアプリで開く」の RPC 発射と失敗トーストは本コンポーネントで完結する
  (macOS の `open` 相当。対象は常に working tree の実ファイル)
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { computed } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { getFileIconUrl } from "../filer";
import { useWorktreeStore } from "../worktree";
import { FileCommitDate } from "./features/commit-history";
import { useMarkdownHistoryStore } from "./features/markdown";
import { rpcOpenFile } from "./rpc";
import IconLucideArrowLeft from "~icons/lucide/arrow-left";
import IconLucideArrowRight from "~icons/lucide/arrow-right";
import IconLucideExternalLink from "~icons/lucide/external-link";
import IconLucideX from "~icons/lucide/x";

const props = defineProps<{
  /** FileCommitDate に渡す props 束。enabled=false なら FileCommitDate は描画も fetch もしない */
  fileCommitDateProps: { dir: string; relPath: string; rev: string; enabled: boolean };
  /** working tree に実体があるときだけ解決される絶対パス。undefined ならボタン非描画 */
  openableAbsPath: string | undefined;
}>();

const emit = defineEmits<{
  close: [];
}>();

const worktreeStore = useWorktreeStore();
const markdownHistory = useMarkdownHistoryStore();
const notification = useNotificationStore();

const selectedDisplayPath = computed(() => worktreeStore.selectedDisplayPath);

function fileName(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

const headerIconUrl = computed(() => {
  const path = selectedDisplayPath.value;
  if (path === undefined) return undefined;
  return getFileIconUrl(fileName(path));
});

/** 表示中ファイルを OS のデフォルトアプリで開く（macOS の `open` 相当）。 */
async function openInDefaultApp() {
  const path = props.openableAbsPath;
  if (path === undefined) return;
  const result = await tryCatch(rpcOpenFile({ path }));
  if (!result.ok) {
    notification.error(`Failed to open file: ${path}`, result.error);
  }
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
        v-if="openableAbsPath"
        type="button"
        class="text-foreground-low hover:text-foreground"
        title="Open in default app"
        aria-label="Open in default app"
        @click="openInDefaultApp()"
      >
        <IconLucideExternalLink class="size-4" />
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
  </div>
</template>
