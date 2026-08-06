<doc lang="md">
worktree が失われた Claude セッションを選び、worktree と task を作り直して会話を再開する
ダイアログ。タイトルとブランチを横断して絞り込める。

一覧が空のとき、取得結果が空だったのか絞り込みで消えたのかを書き分ける。

受理はダイアログを閉じてから走らせる。**閉じること自体が再入への唯一の防壁**で、走っている
受理を覚えておく仕組みは持たない。worktree の作成は時間がかかるため、開いたままだとその間の
キー入力とクリックが届き続ける。
</doc>

<script setup lang="ts">
import type { ReviveSessionInfo } from "@gozd/rpc";
import { useEventListener } from "@vueuse/core";
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { isIMEActive, useContextKeys } from "../../../../shared/command";
import { fuzzyMatch } from "../../fuzzyMatch";
import { useListNavigation } from "../../useListNavigation";
import RevivePickerRow from "./RevivePickerRow.vue";
import { useRevivePicker } from "./useRevivePicker";
import IconLucideLoaderCircle from "~icons/lucide/loader-circle";

const contextKeys = useContextKeys();
const dialogRef = useTemplateRef<HTMLDialogElement>("dialog");
const inputRef = useTemplateRef<HTMLInputElement>("input");
const listRef = useTemplateRef<HTMLDivElement>("list");

const { items: sessionItems, status, showSignal, hideSignal, accept } = useRevivePicker();

const query = ref("");

/** 検索対象テキストを生成（title, branch を結合）。 */
function searchText(session: ReviveSessionInfo): string {
  return `${session.title} ${session.branch}`;
}

const filteredSessions = computed((): ReviveSessionInfo[] => {
  const q = query.value;
  if (q === "") return sessionItems.value;

  const scored: Array<{ session: ReviveSessionInfo; score: number }> = [];
  for (const session of sessionItems.value) {
    const result = fuzzyMatch(searchText(session), q);
    if (result) {
      scored.push({ session, score: result.score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.session);
});

const itemCount = computed(() => filteredSessions.value.length);
const { selectedIndex, move, movePage, reset, scrollToSelected } = useListNavigation({
  listRef,
  itemCount,
});

/** 取得結果自体が空か、フィルタで 0 件になったかで文言を分ける。 */
const emptyMessage = computed(() =>
  sessionItems.value.length === 0 ? "No revivable sessions" : "No matching sessions",
);

/**
 * 常設 live region に出す status テキスト。一覧表示中は空文字。
 * region を v-if で出し入れせずテキストだけ差し替えることで、AT が状態遷移
 * (loading→empty / loading→list) を確実に読み上げる（PrPickerDialog と同じ理由）。
 */
const statusMessage = computed(() => {
  if (status.value === "loading") return "Loading sessions...";
  if (filteredSessions.value.length === 0) return emptyMessage.value;
  return "";
});

watch(filteredSessions, () => {
  reset();
});

watch(showSignal, () => {
  const dialog = dialogRef.value;
  if (!dialog || dialog.open) return;
  query.value = "";
  reset();
  dialog.showModal();
  contextKeys.set("revivePickerVisible", true);
  nextTick(() => {
    inputRef.value?.focus();
    scrollToSelected();
  });
});

// fetch 失敗時、loading で開いた dialog を閉じる (エラーはコマンド側が toast する)。
watch(hideSignal, () => {
  close();
});

function close() {
  dialogRef.value?.close();
  contextKeys.set("revivePickerVisible", false);
}

function acceptSelected() {
  const session = filteredSessions.value[selectedIndex.value];
  if (!session) return;
  close();
  void accept(session);
}

function handleKeydown(e: KeyboardEvent) {
  if (isIMEActive(e)) return;
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      move(1);
      break;
    case "ArrowUp":
      e.preventDefault();
      move(-1);
      break;
    case "PageDown":
      e.preventDefault();
      movePage(1);
      break;
    case "PageUp":
      e.preventDefault();
      movePage(-1);
      break;
    case "Enter":
      e.preventDefault();
      acceptSelected();
      break;
  }
}

useEventListener(dialogRef, "click", (e: MouseEvent) => {
  if (e.target === dialogRef.value) {
    close();
  }
});
</script>

<template>
  <dialog
    ref="dialog"
    class="_revive-picker-dialog"
    aria-label="Revive session picker"
    @keydown="handleKeydown"
    @close="contextKeys.set('revivePickerVisible', false)"
  >
    <div
      class="w-[760px] overflow-hidden rounded-lg border border-border-strong bg-panel shadow-2xl"
    >
      <div class="flex items-center gap-2 border-b border-border p-2">
        <input
          ref="input"
          v-model="query"
          type="text"
          placeholder="Revive a session..."
          aria-label="Filter sessions"
          class="min-w-0 flex-1 bg-transparent px-2 py-1 text-sm text-foreground outline-none placeholder:text-foreground-low"
        />
      </div>
      <!--
        常設 status region: DOM から出し入れせずテキストだけ差し替え、loading→empty /
        loading→list の遷移を AT に確実に読ませる。一覧表示中は空要素として残す (高さ 0・不可視)。
        spinner svg は装飾なので aria-hidden で本文だけ読ませる。
      -->
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        :class="
          statusMessage
            ? 'flex items-center justify-center gap-2 px-3 py-8 text-sm text-foreground-low'
            : ''
        "
      >
        <IconLucideLoaderCircle
          v-if="status === 'loading'"
          aria-hidden="true"
          class="size-4 animate-spin"
        />
        {{ statusMessage }}
      </div>
      <div
        v-if="status === 'ready' && filteredSessions.length > 0"
        ref="list"
        class="max-h-[400px] overflow-y-auto py-1"
      >
        <div
          v-for="(session, i) in filteredSessions"
          :key="session.sessionId"
          class="grid cursor-pointer gap-x-2 px-3 py-1.5 text-sm"
          style="grid-template-columns: 1fr 220px 70px 90px"
          :class="
            i === selectedIndex
              ? 'bg-element text-foreground'
              : 'text-foreground hover:bg-element-hover'
          "
          :title="session.cwd"
          @click="
            () => {
              selectedIndex = i;
              acceptSelected();
            }
          "
        >
          <RevivePickerRow :session="session" />
        </div>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
._revive-picker-dialog {
  margin: 15vh auto 0;
}

._revive-picker-dialog::backdrop {
  background: rgb(0 0 0 / 30%);
}
</style>
