<doc lang="md">
変更ファイル全件の diff を縦に並べて表示するビュー。GitHub PR の Files changed タブ相当。

## 動作

- `useChangesStore` の `fileChanges` を購読し、各ファイルを `ChangesSummaryItem` で描画
- ヘッダーで split / unified の global 切替と word wrap トグルを提供
- ファイル単位の split/unified トグルは externalViewMode prop で非表示にし、ここに統合する
- ファイル fetch 失敗は `fetch-failed` emit を debounce で集約し、N 件の失敗を 1 つの
  `notification.error` toast にまとめる (`useNotificationStore.error` 内部で `console.error` も
  走るため stack が devtools に残る)。per-item の `error.value` は引き続き赤テキストで表示
</doc>

<script setup lang="ts">
import { onUnmounted, ref } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useChangesStore } from "../changes";
import ChangesSummaryItem from "./ChangesSummaryItem.vue";

const emit = defineEmits<{
  close: [];
}>();

const changesStore = useChangesStore();
const notification = useNotificationStore();
const viewMode = ref<"split" | "unified">("split");
const wordWrap = ref(true);

/**
 * 集約された fetch 失敗の状態。`flushDebounceMs` の窓で並列発射された複数失敗を 1 つの
 * toast に丸める。fire 後に reset し、次のバッチで再び集計開始する (selection 変化で
 * 各 item が再 fetch する経路でも新たな失敗があれば再通知される)。
 *
 * トースト message は件数を含めない固定文字列にして、`useNotificationStore.error` の
 * dedup (同一 type + 同一 message で重複抑制) が効くようにする。窓を跨いだ追加失敗も
 * 同じ 1 件のトーストに丸まり、`cause` だけ最新で上書きされる。
 * 件数 / 直近 cause は wrapper Error の message と `Error.cause` chain で詳細パネルに展開される。
 */
const flushDebounceMs = 100;
const TOAST_MESSAGE = "Failed to load some changes in summary";
let failureCount = 0;
let lastCause: Error | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function onItemFetchFailed(cause: Error) {
  failureCount += 1;
  lastCause = cause;
  if (flushTimer !== undefined) return;
  flushTimer = setTimeout(() => {
    const count = failureCount;
    const innerCause = lastCause;
    failureCount = 0;
    lastCause = undefined;
    flushTimer = undefined;
    const noun = count === 1 ? "change" : "changes";
    // 件数情報は wrapper Error の message に詰め、直近 cause を chain に繋ぐ。
    // formatCause.ts の Error chain 展開で詳細パネルに「failure count: N」+「Caused by: <inner>」が出る。
    const aggregate = new Error(`failure count: ${count} ${noun}`, { cause: innerCause });
    notification.error(TOAST_MESSAGE, aggregate);
  }, flushDebounceMs);
}

onUnmounted(() => {
  if (flushTimer !== undefined) clearTimeout(flushTimer);
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <!-- ヘッダー -->
    <div class="flex items-center gap-2 border-b border-border px-3 py-2">
      <span class="icon-[lucide--file-diff] size-4 shrink-0 text-foreground-low" />
      <span class="text-sm text-foreground">Changes summary</span>
      <span v-if="changesStore.fileChanges.length > 0" class="text-xs text-foreground-low">
        ({{ changesStore.fileChanges.length }} files)
      </span>
      <button
        type="button"
        class="ml-auto shrink-0 text-foreground-low hover:text-foreground"
        title="Close preview"
        aria-label="Close preview"
        @click="emit('close')"
      >
        <span class="icon-[lucide--x] size-4" />
      </button>
    </div>

    <!-- ツールバー: view mode と wrap を全 item に伝搬 -->
    <div class="flex items-center border-b border-border">
      <button
        type="button"
        class="flex items-center gap-1 px-3 py-1.5 text-xs transition-colors"
        :class="
          viewMode === 'split' ? 'text-primary-text' : 'text-foreground-low hover:text-foreground'
        "
        title="Split view"
        aria-label="Split view"
        @click="viewMode = 'split'"
      >
        <span class="icon-[lucide--columns-2] size-3.5" />
        Split
      </button>
      <button
        type="button"
        class="flex items-center gap-1 px-3 py-1.5 text-xs transition-colors"
        :class="
          viewMode === 'unified' ? 'text-primary-text' : 'text-foreground-low hover:text-foreground'
        "
        title="Unified view"
        aria-label="Unified view"
        @click="viewMode = 'unified'"
      >
        <span class="icon-[lucide--align-justify] size-3.5" />
        Unified
      </button>

      <button
        type="button"
        class="ml-auto flex items-center gap-1 px-3 py-1.5 text-xs transition-colors"
        :class="wordWrap ? 'text-primary-text' : 'text-foreground-low hover:text-foreground'"
        @click="wordWrap = !wordWrap"
      >
        <span class="icon-[lucide--wrap-text] size-3.5" />
        Wrap
      </button>
    </div>

    <!-- 本体 -->
    <div class="flex-1 overflow-y-auto">
      <div v-if="changesStore.loading" class="p-4 text-sm text-foreground-low">
        Loading changes...
      </div>
      <div
        v-else-if="changesStore.fileChanges.length === 0"
        class="p-4 text-sm text-foreground-low"
      >
        No changes
      </div>
      <template v-else>
        <ChangesSummaryItem
          v-for="change in changesStore.fileChanges"
          :key="`${change.oldFilePath}->${change.newFilePath}`"
          :change="change"
          :view-mode="viewMode"
          :word-wrap="wordWrap"
          @fetch-failed="onItemFetchFailed"
        />
      </template>
    </div>
  </div>
</template>
