<doc lang="md">
変更ファイルの一覧。既定では working tree と HEAD の差を出し、graph でコミットが選ばれている
間はそのコミットの変更に切り替わる。

## 表示

フォルダは既定で開いた状態にする。変更の一覧は「何が変わったか」を一度に見るためのもので、
開く操作を挟ませると目的に届くまでの手数が増える。

## 取得元

ファイル一覧の決定ロジックと RPC fetch は `useChangesStore` が SSOT。ChangesPane は store の
`tree` (描画用) と `orderedFileChanges` (件数表示・空判定・View all ボタンの disabled 制御) を
購読するだけで、自身で tree 構築・ソート・件数判定を行わない。tree 構築失敗時は両者とも空に倒れ、
view 内で「件数あり / 描画は No changes」のような不整合は出ない。

## PR diff toggle

現在ブランチに open PR があるとき、ヘッダーに PR diff toggle が表示される。ON にすると
**`merge-base(HEAD, pr.baseRefOid)`** から working tree までの diff (3-dot semantics、
untracked 含む) に切り替わる。これは GitHub の Files changed タブと同じ意味論で、PR 分岐後に
base ブランチが前進した分は差分に含めない。graph 側の選択 state には触らない (toggle ON 中も
graph 選択は維持) が、ユーザーが graph で commit を選択した瞬間に toggle は自動 OFF になる。
SSOT は `usePrDiffToggleStore`。

PR が stack に属するときは Stack 側も選べる。起点が stack 全体の base になり、stack の下段の変更を
含む累積差分を出す。これは GitHub の stack UI が「この PR とその下の全 PR」を merge 単位として
扱う範囲と一致する。選択は排他で、同時に両方が ON になることはない。

## ヘッダは幅で落とすものを決める

このパネルは Navigator の中にあり、その最小幅は 180px しかない。全部を常時出すと収まらないため、
ヘッダを container にして幅の段で落とす — 220px 未満で件数、280px 未満でセグメントのラベル、
330px 未満で View all のラベル。

落とさないものが 2 つある。

- **パネル名の "Changes"**。これが無いと何の一覧なのか画面から判定できない
- **操作**。セグメントと View all はどの幅でもアイコンとして残す。畳まれた識別子 (PR 番号 /
  stack 位置) は title が持つ

**パネル名の隣にアイコンを置かない**。他のパネル (Git Graph 等) はアイコンと名前を並べるが、あちらは
幅の制約を受けない。アイコンと名前は同じ「どのパネルか」を二重に運んでいて、180px ではこの冗長が
入らない (実測で名前 + 操作だけで 167px、アイコンを足すと 189px)。落とすのは冗長な側にする。

## View all

ヘッダーの View all ボタンは `viewAll` を emit する。summary 表示モードと preview popover の
開閉の同時切り替えは親 (NavigatorPane) が preview store に繋ぐ。select / contextMenu と同じく、
この pane は副作用を持たず event を上へ投げるだけに徹する。
summary 有効時は preview ペインに全変更の縦並び diff が表示される。
</doc>

<script setup lang="ts">
import { ref } from "vue";
import type { FileContextMenuPayload } from "../filer";
import ChangesTreeItem from "./ChangesTreeItem.vue";
import PrDiffSegmented from "./PrDiffSegmented.vue";
import { useChangesStore } from "./useChangesStore";
import { useChangesSummaryStore } from "./useChangesSummaryStore";
import IconLucideFileDiff from "~icons/lucide/file-diff";

const emit = defineEmits<{
  select: [relPath: string];
  /** 右クリック payload を NavigatorPane まで bubble する。hash 解決は navigator + store SSOT */
  contextMenu: [payload: FileContextMenuPayload];
  /** View all ボタン。summary + preview popover の同時切り替えは親が preview store に繋ぐ */
  viewAll: [];
}>();

const changesStore = useChangesStore();
const summaryStore = useChangesSummaryStore();

/** 折りたたみ中フォルダの fullPath 集合（デフォルトは全展開） */
const collapsedFolders = ref<Set<string>>(new Set());

function toggleFolder(fullPath: string) {
  const next = new Set(collapsedFolders.value);
  if (next.has(fullPath)) {
    next.delete(fullPath);
  } else {
    next.add(fullPath);
  }
  collapsedFolders.value = next;
}

function onClickViewAll() {
  emit("viewAll");
}
</script>

<template>
  <div
    class="flex size-full flex-col overflow-hidden border-l border-border bg-background text-foreground"
  >
    <div
      class="@container flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs whitespace-nowrap"
    >
      <span class="shrink-0 font-semibold text-foreground-low">Changes</span>
      <span
        v-if="changesStore.orderedFileChanges.length > 0"
        class="hidden text-foreground-low @min-[220px]:inline"
        >({{ changesStore.orderedFileChanges.length }})</span
      >
      <div class="flex flex-1 items-center justify-end gap-1">
        <PrDiffSegmented />
        <button
          type="button"
          class="flex shrink-0 items-center gap-1 px-1.5 py-0.5 transition-colors"
          :class="
            summaryStore.enabled ? 'text-primary-text' : 'text-foreground-low hover:text-foreground'
          "
          :disabled="changesStore.orderedFileChanges.length === 0"
          title="Show all diffs in preview"
          aria-label="Toggle changes summary"
          @click="onClickViewAll"
        >
          <IconLucideFileDiff class="size-3.5 shrink-0" />
          <span class="hidden @min-[330px]:inline">View all</span>
        </button>
      </div>
    </div>

    <div v-if="changesStore.loading" class="flex-1 overflow-y-auto p-2">
      <div class="text-xs text-foreground-low">Loading...</div>
    </div>

    <div
      v-else-if="changesStore.orderedFileChanges.length === 0"
      class="flex-1 overflow-y-auto p-2"
    >
      <div class="text-xs text-foreground-low">No changes</div>
    </div>

    <div v-else class="flex-1 overflow-y-auto py-1">
      <ChangesTreeItem
        v-for="node in changesStore.tree"
        :key="node.kind === 'folder' ? `d:${node.anchorPath}` : `f:${node.change.newFilePath}`"
        :node="node"
        :depth="0"
        :collapsed="collapsedFolders"
        @select="emit('select', $event)"
        @toggle-folder="toggleFolder"
        @context-menu="(payload) => emit('contextMenu', payload)"
      />
    </div>
  </div>
</template>
