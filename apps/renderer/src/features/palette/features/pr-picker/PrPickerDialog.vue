<doc lang="md">
open な PR を選んで作業先の worktree を開くダイアログ。番号・タイトル・ブランチ・作者を
横断して絞り込め、自分が assignee / reviewer である PR だけに限定するトグルも持つ。

一覧が空のとき、取得結果が空だったのか絞り込みで消えたのかを書き分ける。

## 受理

**通常の受理はダイアログを閉じてから走らせる**。worktree の作成には時間がかかるため、開いた
ままだとその間のキー入力とクリックが、ユーザーにとっては用の済んだダイアログに届き続ける。

**修飾キーを併用した受理だけは閉じずに走らせる**。複数の PR から続けて worktree を作る操作を
1 回の起動で済ませるためで、ダイアログはユーザーが閉じるまで残る。作成が終わった行は「この
repo に task がある」表示へ変わり、次に選ぶと既存 task への切り替えになる。

受理が走っている間、その行は**受理できない**（選択とハイライトは止めない）。進行中であることを
行の上に出し、この表示は picker を閉じて開き直しても残る。
</doc>

<script setup lang="ts">
import type { GitPullRequest } from "@gozd/rpc";
import { useEventListener } from "@vueuse/core";
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { isIMEActive, useContextKeys } from "../../../../shared/command";
import { fuzzyMatch } from "../../fuzzyMatch";
import { useInFlightGhRefs } from "../../inFlightGhRefs";
import { useListNavigation } from "../../useListNavigation";
import PrPickerRow from "./PrPickerRow.vue";
import { usePrPicker } from "./usePrPicker";
import type { PrPickerItem } from "./usePrPicker";
import IconLucideLoaderCircle from "~icons/lucide/loader-circle";

const contextKeys = useContextKeys();
const dialogRef = useTemplateRef<HTMLDialogElement>("dialog");
const inputRef = useTemplateRef<HTMLInputElement>("input");
const listRef = useTemplateRef<HTMLDivElement>("list");

const { items: prItems, viewer, status, showSignal, hideSignal, accept } = usePrPicker();

const query = ref("");
const filterAssignee = ref(false);
const filterReviewer = ref(false);
/** accept 実行中キーの共有集合。設計理由と用途は inFlightGhRefs.ts の module doc が SSOT。 */
const inFlightGhRefs = useInFlightGhRefs();

/** 検索対象テキストを生成（title, branch, author を結合） */
function searchText(pr: GitPullRequest): string {
  return `#${pr.number} ${pr.title} ${pr.headRef} ${pr.author}`;
}

const filteredPrs = computed((): PrPickerItem[] => {
  const v = viewer.value;
  let items = prItems.value;

  // assignee:me / reviewer:me フィルタ
  if (filterAssignee.value && v !== "") {
    items = items.filter((item) => item.pr.assignees.includes(v));
  }
  if (filterReviewer.value && v !== "") {
    items = items.filter((item) => item.pr.reviewers.includes(v));
  }

  const q = query.value;
  if (q === "") return items;

  const scored: Array<{ item: PrPickerItem; score: number }> = [];
  for (const item of items) {
    const result = fuzzyMatch(searchText(item.pr), q);
    if (result) {
      scored.push({ item, score: result.score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
});

const itemCount = computed(() => filteredPrs.value.length);
const { selectedIndex, move, movePage, reset, scrollToSelected } = useListNavigation({
  listRef,
  itemCount,
});

/** 取得結果自体が空か、フィルタで 0 件になったかで文言を分ける。 */
const emptyMessage = computed(() =>
  prItems.value.length === 0 ? "No open pull requests" : "No matching pull requests",
);

/**
 * 常設 live region に出す status テキスト。一覧表示中は空文字。
 * region を v-if で出し入れせずテキストだけ差し替えることで、AT が状態遷移
 * (loading→empty / loading→list) を確実に読み上げる（live region は「先在する
 * region の内容変化」を監視する仕様。同時挿入は取りこぼす）。
 */
const statusMessage = computed(() => {
  if (status.value === "loading") return "Loading pull requests...";
  if (filteredPrs.value.length === 0) return emptyMessage.value;
  return "";
});

watch(filteredPrs, () => {
  reset();
});

watch(showSignal, () => {
  const dialog = dialogRef.value;
  if (!dialog || dialog.open) return;
  query.value = "";
  filterAssignee.value = false;
  filterReviewer.value = false;
  reset();
  dialog.showModal();
  contextKeys.set("prPickerVisible", true);
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
  contextKeys.set("prPickerVisible", false);
}

/**
 * keepOpen (Shift 選択) は dialog を閉じずに accept し、連続作成に使う。
 * 同一 item の accept 実行中だけ再 accept をブロックする (同じ branch 名での二重作成 =
 * 競合になるため)。別 item は並行に accept できる。実行中判定はコマンド層所有の共有集合を
 * 参照する (dialog ローカルだと close / 開き直しで破棄され、通常選択の実行中を塞げない)。
 */
function acceptSelected(keepOpen: boolean) {
  const item = filteredPrs.value[selectedIndex.value];
  if (!item) return;
  if (inFlightGhRefs.has(item.refKey)) return;
  if (!keepOpen) {
    close();
  }
  void accept(item);
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
      acceptSelected(e.shiftKey);
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
    class="_pr-picker-dialog"
    aria-label="Pull request picker"
    @keydown="handleKeydown"
    @close="contextKeys.set('prPickerVisible', false)"
  >
    <div
      class="w-[960px] overflow-hidden rounded-lg border border-border-strong bg-panel shadow-2xl"
    >
      <div class="flex items-center gap-2 border-b border-border p-2">
        <input
          ref="input"
          v-model="query"
          type="text"
          placeholder="Select a pull request..."
          aria-label="Filter pull requests"
          class="min-w-0 flex-1 bg-transparent px-2 py-1 text-sm text-foreground outline-none placeholder:text-foreground-low"
        />
        <label
          v-if="viewer !== ''"
          class="shrink-0 cursor-pointer rounded-sm px-2 py-0.5 text-xs has-focus-visible:ring-2 has-focus-visible:ring-ring"
          :class="
            filterAssignee
              ? 'bg-primary text-foreground'
              : 'bg-element text-foreground-low hover:text-foreground'
          "
        >
          <input v-model="filterAssignee" type="checkbox" class="sr-only" />
          assignee:me
        </label>
        <label
          v-if="viewer !== ''"
          class="shrink-0 cursor-pointer rounded-sm px-2 py-0.5 text-xs has-focus-visible:ring-2 has-focus-visible:ring-ring"
          :class="
            filterReviewer
              ? 'bg-primary text-foreground'
              : 'bg-element text-foreground-low hover:text-foreground'
          "
        >
          <input v-model="filterReviewer" type="checkbox" class="sr-only" />
          reviewer:me
        </label>
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
        v-if="status === 'ready' && filteredPrs.length > 0"
        ref="list"
        class="max-h-[400px] overflow-y-auto py-1"
      >
        <div
          v-for="(item, i) in filteredPrs"
          :key="item.pr.number"
          class="grid cursor-pointer gap-x-2 px-3 py-1.5 text-sm"
          style="grid-template-columns: 70px 1fr 220px 120px 90px"
          :class="[
            // 既存 task 行の tint (bg-primary-subtle) は持たない。カーソル行の bg-selection と
            // 同一色相の隣接 step になり判別できないため、has-task の表示はチェックアイコンに譲る
            i === selectedIndex
              ? 'bg-selection text-foreground'
              : 'text-foreground hover:bg-element-hover',
            item.pr.isDraft && 'opacity-50',
          ]"
          @click="
            (e) => {
              selectedIndex = i;
              acceptSelected(e.shiftKey);
            }
          "
        >
          <PrPickerRow
            :pr="item.pr"
            :has-task="item.existingTask !== undefined"
            :creating="inFlightGhRefs.has(item.refKey)"
          />
        </div>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
._pr-picker-dialog {
  margin: 15vh auto 0;
}

._pr-picker-dialog::backdrop {
  background: rgb(0 0 0 / 30%);
}
</style>
