<doc lang="md">
認証ユーザー単位の作業一覧（自分の issue / 自分の PR / 自分へのメンション / レビュー依頼）を
repo 横断で出す右ドック型パネル。TitleBar のボタン → `useMyWorkStore.toggle()` で開閉する。

ServerListPanel / EventLogPanel と同じ top layer サーフェス 1 枚（`shared/surface`）。開閉の
SSOT は store の `isOpen` で、popover DOM へのミラーは要素を所有する本 component が担う。

## 軸ごとのペイン構成

軸を横並びのペインに分け、**ペインごとに独立して縦スクロール**させる。1 つの scroll に
積むと、件数の多い軸（レビュー依頼が数十件になる）が他の軸を画面外へ押し出し、どの軸に何件
あるかを掴むのにスクロールが要る。

このため他のドックパネルより横幅を要する。ウィンドウ幅を超えないよう上限を切り、狭い
ウィンドウではウィンドウ幅まで縮む。

## 未読の絞り込み

ヘッダのトグルは**全ペインに一括で効く**。未読を拾うのが目的なので、軸ごとに持たせると
目的に対して操作が軸の数だけ増える。

絞り込んでもペインは枠ごと残る（件数 0 のペインを残すのと同じ理由）。並びと幅が状況で
変わると、どの軸を見ているのかが掴めなくなる。

## 取得の発火

`fetchIfDue` を呼ぶ条件を **「対象の出入り」** として持つ。対象とは「パネルが開いていて、かつ
ウィンドウが focus されている」状態で、これが true になった瞬間と 60 秒間隔の 2 つが発火元。
focus 専用の発火トリガは持たない（`GitGraphPane` の PR poll と同じ規律）。

lock（60 秒）は store が持つため、閉じて開き直しても 60 秒未満なら撃たずキャッシュを出す。
blur 中に対象から外れるのは、見ていない間に GitHub API を消費し失敗トーストを溜めないため。

## 本文の 3 状態

「未取得で取得中」「未取得で失敗」「取得済み」を描き分ける。取得済みかどうかの 1 bit だけで
分岐すると、初回取得が失敗したときに進行中の取得が無いまま `Loading…` が残り続け、しかも
lock のせいで開き直しても撃たないため、無説明の画面が固着する。

取得済みで直近の取得が失敗しているときは、表示が stale であることをヘッダーに出す。トーストは
流れて消えるので、それだけでは失敗が画面から失われる。

失敗表示には GitHub 上の一覧への導線を残す。gh が使えない状態こそ GitHub 側で確認したい場面で、
URL は取得の成否に依存しないため失敗応答からも得られる。

## repo に紐づかない

一覧は認証ユーザー単位なので、active repo / worktree の切替では何も起きない。gozd で開いて
いない repo の PR も並ぶ。
</doc>

<script setup lang="ts">
import type { GitMyWorkAxisKey } from "@gozd/rpc";
import { GIT_MY_WORK_AXIS_KEYS } from "@gozd/rpc";
import { useIntervalFn, useWindowFocus } from "@vueuse/core";
import { computed, useTemplateRef, watch } from "vue";
import { useSurface } from "../../shared/surface";
import { activateExternalLink, ITEM_KIND_DISPLAY } from "../github-item";
import MyWorkSection from "./MyWorkSection.vue";
import { MY_WORK_FRESH_MS, useMyWorkStore } from "./useMyWorkStore";
import IconLucideInbox from "~icons/lucide/inbox";
import IconLucideRefreshCw from "~icons/lucide/refresh-cw";
import IconLucideTriangleAlert from "~icons/lucide/triangle-alert";
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

/**
 * 軸キー → ペインの見出しラベル。Record で鍵付けするため、軸の増減はここが compile error で
 * 追従を要求する。
 */
const AXIS_TITLES: Record<GitMyWorkAxisKey, string> = {
  authoredIssues: "My issues",
  authoredPrs: "My pull requests",
  mentioned: "Mentioned",
  reviewRequestedPrs: "Review requested",
};

/**
 * ペインと失敗表示のリンクはどちらもこれを回す。軸の集合と並びは `GIT_MY_WORK_AXIS_KEYS` から
 * 導出し、ここはラベルを与えるだけ。並びは、自分が作ったもの（issue → PR）→ 自分に
 * 向けられたもの（メンション → レビュー依頼）。issue → PR の順は GitHub web の種別並び
 * （Issues / Pull requests）に合わせる。
 */
const AXES = computed(() =>
  GIT_MY_WORK_AXIS_KEYS.map((key) => ({
    key,
    title: AXIS_TITLES[key],
    group: myWorkStore.groups[key],
  })),
);

/**
 * 一覧を出せないときに残す GitHub への導線。URL は取得の成否に依存しないが、main から
 * 一度も応答が届いていなければ手元に無い（webLinks が空）ので、その軸は出さない
 * （描けないものを描かない）。混在軸はリンクが種別ごとに分かれるため、軸名に種別を添える。
 */
const failureLinks = computed(() =>
  AXES.value.flatMap((axis) => {
    const webLinks = axis.group.webLinks;
    return webLinks.map((link) => ({
      label:
        webLinks.length === 1
          ? axis.title
          : `${axis.title} (${ITEM_KIND_DISPLAY[link.kind].label})`,
      url: link.url,
    }));
  }),
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
    class="_my-work-popover w-[min(1440px,100vw)] flex-col border-0 border-l border-border bg-panel p-0 shadow-xl outline-hidden [&:popover-open]:flex"
    @pointerdown.capture="raise()"
  >
    <header class="flex items-center gap-2 border-b border-border px-3 py-2">
      <IconLucideInbox class="size-4 text-foreground-low" />
      <h2 class="text-sm font-medium text-foreground">My work</h2>
      <!-- キャッシュを出しつつ直近の取得が失敗している状態。トーストは消えるのでここに残す -->
      <span
        v-if="myWorkStore.hasLoaded && myWorkStore.lastError !== undefined"
        class="flex min-w-0 flex-1 items-center gap-1 text-xs text-warning-text"
        :title="myWorkStore.lastError"
      >
        <IconLucideTriangleAlert class="size-3.5 shrink-0" />
        <span class="truncate">Showing stale data</span>
      </span>
      <span v-else class="flex-1"></span>
      <label
        class="shrink-0 cursor-pointer rounded-sm px-2 py-0.5 text-xs has-focus-visible:ring-2 has-focus-visible:ring-ring"
        :class="
          myWorkStore.unreadOnly
            ? 'bg-primary text-primary-foreground'
            : 'bg-element text-foreground-low hover:text-foreground'
        "
      >
        <input v-model="myWorkStore.unreadOnly" type="checkbox" class="sr-only" />
        Unread only
      </label>
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

    <!-- 未取得。失敗しているならその理由を出す（進行中でないのに Loading を出さない） -->
    <div
      v-if="!myWorkStore.hasLoaded"
      class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-xs"
    >
      <template v-if="myWorkStore.lastError === undefined">
        <span class="text-foreground-low">Loading…</span>
      </template>
      <template v-else>
        <IconLucideTriangleAlert class="size-6 text-destructive-text" />
        <span class="text-foreground">{{ myWorkStore.lastError }}</span>
        <button
          type="button"
          :disabled="myWorkStore.isLoading"
          class="rounded-sm bg-element px-3 py-1 text-foreground not-disabled:cursor-pointer not-disabled:hover:bg-element-hover disabled:text-foreground-muted"
          @click="myWorkStore.refresh()"
        >
          Retry
        </button>
        <!-- 一覧が出せない間の逃げ道。gh が使えない状態こそ GitHub 側で見たい -->
        <div v-if="failureLinks.length > 0" class="flex flex-wrap justify-center gap-3">
          <a
            v-for="link in failureLinks"
            :key="link.url"
            :href="link.url"
            class="text-primary-text underline"
            @click="activateExternalLink($event, link.url)"
            @auxclick="activateExternalLink($event, link.url)"
          >
            {{ link.label }}
          </a>
        </div>
      </template>
    </div>

    <div v-else class="flex min-h-0 flex-1">
      <MyWorkSection
        v-for="axis in AXES"
        :key="axis.key"
        :title="axis.title"
        :group="axis.group"
        :unread-only="myWorkStore.unreadOnly"
      />
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
