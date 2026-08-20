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
import { useEventListener, useInfiniteScroll } from "@vueuse/core";
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { isIMEActive, useContextKeys } from "../../../../shared/command";
import { fuzzyMatch } from "../../fuzzyMatch";
import { useInFlightGhRefs } from "../../inFlightGhRefs";
import { useListNavigation } from "../../useListNavigation";
import { prPickerCountsLabel, prPickerEmptyMessage } from "./prPickerListDisplay";
import PrPickerRow from "./PrPickerRow.vue";
import { usePrPicker } from "./usePrPicker";
import type { PrPickerItem } from "./usePrPicker";
import IconLucideLoaderCircle from "~icons/lucide/loader-circle";

const contextKeys = useContextKeys();
const dialogRef = useTemplateRef<HTMLDialogElement>("dialog");
const inputRef = useTemplateRef<HTMLInputElement>("input");
const listRef = useTemplateRef<HTMLDivElement>("list");

const {
  items: prItems,
  viewer,
  status,
  loadingMore,
  hasMore,
  totalCount,
  pagedOnce,
  showSignal,
  hideSignal,
  requestMore,
  markClosed,
  accept,
} = usePrPicker();

const query = ref("");
const filterAssignee = ref(false);
const filterReviewer = ref(false);
/** accept 実行中キーの共有集合。設計理由と用途は inFlightGhRefs.ts の module doc が SSOT。 */
const inFlightGhRefs = useInFlightGhRefs();

/** 検索対象テキストを生成（title, branch, author を結合） */
function searchText(pr: GitPullRequest): string {
  return `#${pr.number} ${pr.title} ${pr.headRef} ${pr.author}`;
}

/** 空白だけの入力は絞り込みではない。絞り込みの判定と実際の絞り込みが同じ値を見る */
const activeQuery = computed(() => query.value.trim());

/** 絞り込みが掛かっているか。掛かっている間は続きを取りに行かない。 */
const isFiltered = computed(
  () => activeQuery.value !== "" || filterAssignee.value || filterReviewer.value,
);

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

  const q = activeQuery.value;
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
  // 継ぎ足しで伸びる一覧なので下端は終端ではない。回り込むと「続きを見に行く」操作が
  // 先頭への移動になる
  wrap: false,
});

/** 件数と空文言の判定は `prPickerListDisplay` が持つ（組合せをテストで固定するため）。 */
const listState = computed(() => ({
  isFiltered: isFiltered.value,
  shownCount: filteredPrs.value.length,
  loadedCount: prItems.value.length,
  totalCount: totalCount.value,
  hasMore: hasMore.value,
}));

const emptyMessage = computed(() => prPickerEmptyMessage(listState.value));

const countsLabel = computed(() => prPickerCountsLabel(listState.value));

/**
 * 末尾に近づいたら次のページを要求する。
 *
 * スクロール量を自前で測らない。`useInfiniteScroll` は到達判定に加えて、**一覧が伸びなかった
 * 場合の再判定**と**コンテナがスクロールできない場合の取得**を持つ。自前の scroll ハンドラは
 * どちらも取りこぼし、fork PR だけのページを足して DOM が 1px も動かないと次の契機が永久に
 * 来なくなる。
 *
 * **絞り込み中は取りに行かない**（契約は docs/git.md の「PR の取得は問いごとに分ける」）。
 */
const LOAD_MORE_DISTANCE_PX = 200;
useInfiniteScroll(listRef, () => requestMore(), {
  distance: LOAD_MORE_DISTANCE_PX,
  canLoadMore: () => !isFiltered.value && hasMore.value,
});

/**
 * 常設 live region に出す status テキスト。一覧表示中は空文字。
 * region を v-if で出し入れせずテキストだけ差し替えることで、AT が状態遷移
 * (loading→empty / loading→list) を確実に読み上げる（live region は「先在する
 * region の内容変化」を監視する仕様。同時挿入は取りこぼす）。
 */
const visibleStatus = computed(() => {
  if (status.value === "loading") return "Loading pull requests...";
  if (filteredPrs.value.length === 0) return emptyMessage.value;
  return "";
});

/**
 * live region が読み上げる状態。**見せる状態の上位集合。**
 *
 * 継ぎ足しは末尾のフッタで見せるが、あちらは role を持たない装飾要素なので支援技術には届かない。
 * かといってこの region の可視表示に載せると、一覧が出ている最中に高さのあるブロックが割り込んで
 * 読んでいる位置が跳ねる。読み上げだけを足し、見た目は `visibleStatus` が決める。
 */
const statusMessage = computed(() => {
  if (visibleStatus.value !== "") return visibleStatus.value;
  if (loadingMore.value) return "Loading more pull requests...";
  return "";
});

/**
 * 選択位置は**絞り込み条件が変わったときだけ**先頭へ戻す。
 *
 * 一覧そのもの (`filteredPrs`) を監視すると、続きのページを足しただけで選択が先頭へ飛ぶ。
 * 追記は同じ問いに対する結果が伸びただけで、別の答えに変わったわけではない。条件が変われば
 * 結果集合は別物になり、そのときは範囲外を指しうるので先頭へ戻す。
 */
watch([query, filterAssignee, filterReviewer], () => {
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

/**
 * dialog が閉じたときの状態遷移。**Esc は native の cancel → close で閉じるため `close()` を
 * 通らない。**閉じ方によらず必ず通る `@close` に集約する。
 */
function handleClose() {
  // close イベントはタスクとしてキューされるため、閉じた直後に開き直すと開いた後の dialog へ
  // 届く。仕様上 `open` は close イベントを queue する前に落ちるので、届いた時点でまだ開いて
  // いれば、それは自分より後の表示に追い越された古い通知
  if (dialogRef.value?.open === true) return;
  markClosed();
  contextKeys.set("prPickerVisible", false);
}

function close() {
  dialogRef.value?.close();
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
    @close="handleClose"
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
              ? 'bg-primary text-primary-foreground'
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
              ? 'bg-primary text-primary-foreground'
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
          visibleStatus
            ? 'flex items-center justify-center gap-2 px-3 py-8 text-sm text-foreground-low'
            : 'sr-only'
        "
      >
        <IconLucideLoaderCircle
          v-if="status === 'loading'"
          aria-hidden="true"
          class="size-4 animate-spin"
        />
        {{ statusMessage }}
      </div>
      <div v-if="status === 'ready'" ref="list" class="max-h-[400px] overflow-y-auto py-1">
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
        <!--
          一覧の末尾に「この先どうなっているか」を置く。何も無いと、末尾が母集合の終端なのか
          未取得が残っているのかが画面から判別できない。ページに分かれていない取得では
          問い自体が立たないので出さない。
        -->
        <div
          v-if="pagedOnce && (loadingMore || !hasMore)"
          class="flex items-center justify-center gap-2 px-3 py-2 text-xs text-foreground-low"
        >
          <template v-if="loadingMore">
            <IconLucideLoaderCircle aria-hidden="true" class="size-3 animate-spin" />
            Loading more...
          </template>
          <template v-else-if="!hasMore">
            <span aria-hidden="true" class="h-px w-6 bg-border-strong" />
            End of list
            <span aria-hidden="true" class="h-px w-6 bg-border-strong" />
          </template>
        </div>
      </div>
      <!-- 絞り込み後 / 取得済み / 総数 -->
      <div
        v-if="countsLabel !== ''"
        class="border-t border-border px-3 py-1 text-right text-xs text-foreground-low"
      >
        {{ countsLabel }}
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
