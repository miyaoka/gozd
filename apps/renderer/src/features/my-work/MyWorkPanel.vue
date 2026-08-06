<doc lang="md">
認証ユーザー単位の作業一覧（自分の PR / レビュー依頼 / 自分の issue）を repo 横断で出す
右ドック型パネル。TitleBar のボタン → `useMyWorkStore.toggle()` で開閉する。

ServerListPanel / EventLogPanel と同じ top layer サーフェス 1 枚（`shared/surface`）。開閉の
SSOT は store の `isOpen` で、popover DOM へのミラーは要素を所有する本 component が担う。

## 3 ペイン構成

3 つの軸を横並びのペインに分け、**ペインごとに独立して縦スクロール**させる。1 つの scroll に
積むと、件数の多い軸（レビュー依頼が数十件になる）が他の軸を画面外へ押し出し、どの軸に何件
あるかを掴むのにスクロールが要る。

このため他のドックパネルより横幅を要する。ウィンドウ幅を超えないよう上限を切り、狭い
ウィンドウではウィンドウ幅まで縮む。

## 取得の発火

`fetchIfDue` を呼ぶ条件を **「対象の出入り」** として持つ。対象とは「パネルが開いていて、かつ
ウィンドウが focus されている」状態で、これが true になった瞬間と 60 秒間隔の 2 つが発火元。
focus 専用の発火トリガは持たない（`GitGraphPane` の PR poll と同じ規律）。

lock（60 秒）は store が持つため、閉じて開き直しても 60 秒未満なら撃たずキャッシュを出す。
blur 中に対象から外れるのは、見ていない間に GitHub API を消費し失敗トーストを溜めないため。

## repo に紐づかない

一覧は認証ユーザー単位なので、active repo / worktree の切替では何も起きない。gozd で開いて
いない repo の PR も並ぶ。
</doc>

<script setup lang="ts">
import { useIntervalFn, useWindowFocus } from "@vueuse/core";
import { computed, useTemplateRef, watch } from "vue";
import { useSurface } from "../../shared/surface";
import MyWorkSection from "./MyWorkSection.vue";
import { MY_WORK_FRESH_MS, useMyWorkStore } from "./useMyWorkStore";
import IconLucideInbox from "~icons/lucide/inbox";
import IconLucideRefreshCw from "~icons/lucide/refresh-cw";
import IconLucideX from "~icons/lucide/x";

const myWorkStore = useMyWorkStore();
const focused = useWindowFocus();

/** 取得対象であるか。開いていて focus 中のときだけ true。 */
const isPollTarget = computed(() => myWorkStore.isOpen && focused.value);

// 対象の出入り（パネル開閉 / focus 復帰・喪失）で取得。lock 中はキャッシュのまま no-op。
watch(isPollTarget, (target) => {
  if (target) myWorkStore.fetchIfDue();
});

// 開いている間の定期取得。対象外のときは撃たない。
useIntervalFn(
  () => {
    if (isPollTarget.value) myWorkStore.fetchIfDue();
  },
  MY_WORK_FRESH_MS,
  { immediateCallback: false },
);

const panelRef = useTemplateRef<HTMLElement>("panel");

const { raise } = useSurface(panelRef, {
  isOpen: () => myWorkStore.isOpen,
  requestClose: () => myWorkStore.close(),
});
</script>

<template>
  <div
    ref="panel"
    popover="manual"
    tabindex="-1"
    class="_my-work-popover w-[min(1080px,100vw)] flex-col border-0 border-l border-border bg-panel p-0 shadow-xl outline-hidden [&:popover-open]:flex"
    @pointerdown.capture="raise()"
  >
    <header class="flex items-center gap-2 border-b border-border px-3 py-2">
      <IconLucideInbox class="size-4 text-foreground-low" />
      <h2 class="flex-1 text-sm font-medium text-foreground">My work</h2>
      <button
        type="button"
        aria-label="Refresh"
        title="Refresh"
        :disabled="myWorkStore.isLoading"
        class="grid size-6 place-items-center rounded-sm text-foreground-low not-disabled:hover:bg-element-hover not-disabled:hover:text-foreground disabled:text-foreground-muted"
        @click="myWorkStore.refresh()"
      >
        <IconLucideRefreshCw class="size-3.5" :class="myWorkStore.isLoading && 'animate-spin'" />
      </button>
      <button
        type="button"
        aria-label="Close"
        class="grid size-6 place-items-center rounded-sm text-foreground-low hover:bg-element-hover hover:text-foreground"
        @click="myWorkStore.close()"
      >
        <IconLucideX class="size-4" />
      </button>
    </header>

    <p v-if="!myWorkStore.hasLoaded" class="px-3 py-8 text-center text-xs text-foreground-low">
      Loading…
    </p>

    <div v-else class="flex min-h-0 flex-1">
      <MyWorkSection title="Review requested" :group="myWorkStore.reviewRequestedPrs" />
      <MyWorkSection title="My pull requests" :group="myWorkStore.authoredPrs" />
      <MyWorkSection title="My issues" :group="myWorkStore.authoredIssues" />
    </div>
  </div>
</template>

<style>
._my-work-popover {
  /* タイトルバー（drag 領域）を覆わないよう、上端をその直下に置き右端に沿わせる */
  inset: unset;
  margin: 0;
  top: var(--titlebar-height);
  right: 0;
  bottom: 0;
  /* UA スタイル [popover] { height: fit-content } を打ち消す。
     height が auto でないと top + bottom の伸縮が効かずコンテンツ高さに縮む */
  height: auto;
  max-height: none;
}
</style>
