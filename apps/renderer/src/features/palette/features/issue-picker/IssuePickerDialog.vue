<doc lang="md">
open な issue を選んで作業先の worktree を開くダイアログ。番号・タイトル・作者を横断して
絞り込め、自分が assignee である issue だけに限定するトグルも持つ。

## 待ちと空を必ず見せる

一覧の取得を待たずに開き、解決したら中身を差し替える。GitHub への問い合わせには待ちがあり、
完了まで何も出さないと「コマンドが効かなかった」と区別が付かない。取得結果が 0 件のときも
同じ理由で、空であることを明示する。取得が空だったのか絞り込みで消えたのかは書き分ける。

状態を伝えるテキストは領域ごと出し入れせず、中身だけを差し替える。支援技術が変化を読み上げる
には、変化する前からその領域が存在している必要がある。領域と文字を同時に挿入すると読み上げが
落ちる。

## 受理と、走っている受理

受理はダイアログを閉じてから走らせる。worktree の作成には時間がかかるため、開いたままだと
その間のキー入力とクリックが、ユーザーにとっては用の済んだダイアログに届き続ける。

**同じ issue を二重に受理させない判断はコマンド層が持つ**。ダイアログの状態は閉じると消える
ため、裏で走っている作成をダイアログ側では覚えていられない。走っている間は行を選べなくし、
進行中であることを行の上に出す。この表示は picker を閉じて開き直しても残る。

止めたいのはブランチ名の衝突ではなく、**同じ issue に worktree が 2 つできること**。issue から
起こすブランチ名は起動ごとに一意なので、二重受理は失敗せずに重複を作る。別の行どうしは
並行して受理できる。

修飾キーを併用した受理はダイアログを閉じない。複数の issue から続けて worktree を作る操作を
1 回の起動で済ませるため。作成が終わった行は「この repo に task がある」表示へ変わり、
次に選ぶと新規作成ではなく既存 task への切り替えになる。
</doc>

<script setup lang="ts">
import type { GitIssue } from "@gozd/rpc";
import { useEventListener } from "@vueuse/core";
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { isIMEActive, useContextKeys } from "../../../../shared/command";
import { fuzzyMatch } from "../../fuzzyMatch";
import { useInFlightGhRefs } from "../../inFlightGhRefs";
import { useListNavigation } from "../../useListNavigation";
import IssuePickerRow from "./IssuePickerRow.vue";
import { useIssuePicker } from "./useIssuePicker";
import type { IssuePickerItem } from "./useIssuePicker";
import IconLucideLoaderCircle from "~icons/lucide/loader-circle";

const contextKeys = useContextKeys();
const dialogRef = useTemplateRef<HTMLDialogElement>("dialog");
const inputRef = useTemplateRef<HTMLInputElement>("input");
const listRef = useTemplateRef<HTMLDivElement>("list");

const { items: issueItems, viewer, status, showSignal, hideSignal, accept } = useIssuePicker();

const query = ref("");
const filterAssignee = ref(false);
/** accept 実行中キーの共有集合。設計理由は inFlightGhRefs.ts の module doc が SSOT。
 * 実行中の行は選択ブロック + スピナー表示に使う */
const inFlightGhRefs = useInFlightGhRefs();

/** 検索対象テキストを生成（number, title, author を結合） */
function searchText(issue: GitIssue): string {
  return `#${issue.number} ${issue.title} ${issue.author}`;
}

const filteredIssues = computed((): IssuePickerItem[] => {
  const v = viewer.value;
  let items = issueItems.value;

  // assignee:me フィルタ
  if (filterAssignee.value && v !== "") {
    items = items.filter((item) => item.issue.assignees.includes(v));
  }

  const q = query.value;
  if (q === "") return items;

  const scored: Array<{ item: IssuePickerItem; score: number }> = [];
  for (const item of items) {
    const result = fuzzyMatch(searchText(item.issue), q);
    if (result) {
      scored.push({ item, score: result.score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
});

const itemCount = computed(() => filteredIssues.value.length);
const { selectedIndex, move, movePage, reset, scrollToSelected } = useListNavigation({
  listRef,
  itemCount,
});

/** 取得結果自体が空か、フィルタで 0 件になったかで文言を分ける。 */
const emptyMessage = computed(() =>
  issueItems.value.length === 0 ? "No open issues" : "No matching issues",
);

/**
 * 常設 live region に出す status テキスト。一覧表示中は空文字。
 * region を v-if で出し入れせずテキストだけ差し替えることで、AT が状態遷移
 * (loading→empty / loading→list) を確実に読み上げる（live region は「先在する
 * region の内容変化」を監視する仕様。同時挿入は取りこぼす）。
 */
const statusMessage = computed(() => {
  if (status.value === "loading") return "Loading issues...";
  if (filteredIssues.value.length === 0) return emptyMessage.value;
  return "";
});

watch(filteredIssues, () => {
  reset();
});

watch(showSignal, () => {
  const dialog = dialogRef.value;
  if (!dialog || dialog.open) return;
  query.value = "";
  filterAssignee.value = false;
  reset();
  dialog.showModal();
  contextKeys.set("issuePickerVisible", true);
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
  contextKeys.set("issuePickerVisible", false);
}

/**
 * keepOpen (Shift 選択) は dialog を閉じずに accept し、連続作成に使う。
 * 同一 item の accept 実行中だけ再 accept をブロックする (同 issue の worktree 二重作成に
 * なるため)。別 item は並行に accept できる。実行中判定はコマンド層所有の共有集合を
 * 参照する (dialog ローカルだと close / 開き直しで破棄され、通常選択の実行中を塞げない)。
 */
function acceptSelected(keepOpen: boolean) {
  const item = filteredIssues.value[selectedIndex.value];
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
    class="_issue-picker-dialog"
    aria-label="Issue picker"
    @keydown="handleKeydown"
    @close="contextKeys.set('issuePickerVisible', false)"
  >
    <div
      class="w-[780px] overflow-hidden rounded-lg border border-border-strong bg-panel shadow-2xl"
    >
      <div class="flex items-center gap-2 border-b border-border p-2">
        <input
          ref="input"
          v-model="query"
          type="text"
          placeholder="Select an issue..."
          aria-label="Filter issues"
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
        v-if="status === 'ready' && filteredIssues.length > 0"
        ref="list"
        class="max-h-[400px] overflow-y-auto py-1"
      >
        <div
          v-for="(item, i) in filteredIssues"
          :key="item.issue.number"
          class="grid cursor-pointer gap-x-2 px-3 py-1.5 text-sm"
          style="grid-template-columns: 70px 1fr 120px 90px"
          :class="[
            i === selectedIndex
              ? 'bg-element text-foreground'
              : item.existingTask !== undefined
                ? 'bg-primary-subtle text-foreground hover:bg-primary-subtle-hover'
                : 'text-foreground hover:bg-element-hover',
          ]"
          @click="
            (e) => {
              selectedIndex = i;
              acceptSelected(e.shiftKey);
            }
          "
        >
          <IssuePickerRow
            :issue="item.issue"
            :has-task="item.existingTask !== undefined"
            :creating="inFlightGhRefs.has(item.refKey)"
          />
        </div>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
._issue-picker-dialog {
  margin: 15vh auto 0;
}

._issue-picker-dialog::backdrop {
  background: rgb(0 0 0 / 30%);
}
</style>
