<doc lang="md">
1 つの repo を表すサイドバーセクション。

ヘッダ (repo アイコン + repo 名 + chevron + 編集モード時の ✕) と、
配下の WtCard 列 (main wt 先頭固定、その後 worktrees 配列順) + `+ New worktree`。

## 並び順

1. main wt
2. その他 wt: repoStore.worktrees の append 順を維持 (= git worktree list の順)
3. `+ New worktree` ボタン

state による並び替えは行わない。Claude 起動 / 状態遷移でカード位置が動くと
「どこに何があるか」を覚えていられないため、位置は静的に保ち、状態は state
アイコンで識別する。

## 操作

- header 全体クリック: git repo は折りたたみトグル (永続)、非 git project は rootDir を
  active dir に選択 (ファイラー表示の唯一の経路)。非 git は worktree カードを持たず畳む対象が
  無いため chevron も出さない。編集モード中はどちらも無効
- 編集モード時のみ ✕ 表示 + drag handle 有効。✕ クリックで window から repo を解除

## レイアウト（行 = full-bleed）

VS Code の pane header / tree row と同じ原則で、header は panel 幅いっぱいの
1 コントロールにする（section は padding を持たず、padding は header 内の button と
コンテンツ列が各自持つ）。focus ring / hover は常に行全体に付き、collapsed 時は
panel = header だけになるため「パネル全体がフォーカスされている」表示になる。
テキストを shrink-wrap する input 風の focus 箱を作らない。

## ハイライト

active worktree を所有する repo は section 枠を薄い primary 線 + 浮き上がる影で示す
(`._fx-panel[data-active]`)。塗り / グローは持たせず、wt カードの border-primary + 外周
グローより弱くする。同じ青でも「枠線 (repo) < 枠線 + グロー (wt)」で主従が分かれ、wt
ハイライトが repo 枠に埋もれない。

## 開閉アニメーション

wt カード列の開閉は `<Transition>` で height 0 ↔ auto を CSS transition する
（`interpolate-size: allow-keywords` で auto が補間可能になる。Chromium 129+）。
transition root は padding を持たず height だけを補間し、padding は内側の div が持つ
（root が padding を持つと border-box でも h-0 時に padding 分の高さが残る）。
`overflow-hidden` は enter/leave の active class にだけ載せる。定常状態で clip すると
active wt カードの外周ブルーム（`_fx-quest-active` の box-shadow）が消えるため
（WtCard の「カード境界に overflow-hidden を使わない」規律と同根）。
</doc>

<script setup lang="ts">
import { useSortable } from "@dnd-kit/vue/sortable";
import type { Task, WorktreeEntry } from "@gozd/rpc";
import { computed, useTemplateRef } from "vue";
import { useRepoStore } from "../../../../shared/repo";
import { RepoIcon } from "../../../repo-icon";
import { WtCard } from "../worktree";
import IconLucideChevronDown from "~icons/lucide/chevron-down";
import IconLucideEllipsisVertical from "~icons/lucide/ellipsis-vertical";
import IconLucideLoaderCircle from "~icons/lucide/loader-circle";
import IconLucidePlus from "~icons/lucide/plus";
import IconLucideX from "~icons/lucide/x";

const props = defineProps<{
  rootDir: string;
  index: number;
  editMode: boolean;
  activeDir: string | undefined;
  isCreating: boolean;
  getFocusedPtyId: (dir: string) => number | undefined;
}>();

const emit = defineEmits<{
  removeRepo: [rootDir: string];
  selectRoot: [rootDir: string];
  selectWt: [wt: WorktreeEntry];
  selectTask: [wt: WorktreeEntry, task: Task];
  addWorktree: [rootDir: string];
  openWorktreeMenu: [anchorEl: HTMLElement, wt: WorktreeEntry, rootDir: string];
  openTaskMenu: [anchorEl: HTMLElement, task: Task, rootDir: string];
  openRepoMenu: [anchorEl: HTMLElement, rootDir: string];
}>();

const repoStore = useRepoStore();

const repo = computed(() => repoStore.repos[props.rootDir]);
const repoName = computed(() => repo.value?.repoName ?? props.rootDir);
const isGitRepo = computed(() => repo.value?.isGitRepo ?? false);
const collapsed = computed(() => repoStore.isCollapsed(props.rootDir));

const active = computed(() => repoStore.selectedRootDir === props.rootDir);

/** GitHub owner (org / 個人ユーザー)。取得は useSidebarData、SSOT は repoStore.githubIdentity */
const githubOwner = computed(() => repo.value?.githubIdentity?.owner ?? "");

const worktrees = computed(() => repo.value?.worktrees ?? []);

/**
 * main wt 先頭固定、その他は repoStore の worktrees 配列順を維持。
 * Claude state による並び替えは行わない (位置の安定性を優先)。
 */
const orderedWorktrees = computed(() => {
  const all = worktrees.value;
  const main = all.find((wt) => wt.isMain);
  const others = all.filter((wt) => !wt.isMain);
  return main !== undefined ? [main, ...others] : others;
});

const sectionEl = useTemplateRef<HTMLElement>("section");
const dragHandleEl = useTemplateRef<HTMLElement>("dragHandle");

useSortable({
  id: computed(() => props.rootDir),
  index: computed(() => props.index),
  element: sectionEl,
  handle: dragHandleEl,
  disabled: computed(() => !props.editMode),
});

const visiblyCollapsed = computed(() => collapsed.value || props.editMode);

// wt カード列が実際に展開表示されているか（非 git はカード列を持たないので常に false）
const bodyVisible = computed(() => isGitRepo.value && !visiblyCollapsed.value);

// テンプレートでネスト三項を書かず、ヘッダの aria はスクリプト側で導出する。
// git repo は折りたたみトグル (Expand/Collapse + aria-expanded)、非 git project は
// rootDir 選択ボタン (Open directory、折りたたみ概念なし) として振る舞う。
const headerAriaLabel = computed(() => {
  if (props.editMode) return undefined;
  if (!isGitRepo.value) return "Open directory";
  return visiblyCollapsed.value ? "Expand" : "Collapse";
});
const headerAriaExpanded = computed(() =>
  props.editMode || !isGitRepo.value ? undefined : !visiblyCollapsed.value,
);

// ⋮ menu trigger。currentTarget (ボタン要素) を anchor として emit する (WtCard と同じ規約)。
function onOpenMenu(event: MouseEvent) {
  event.stopPropagation();
  const target = event.currentTarget;
  if (target instanceof HTMLElement) emit("openRepoMenu", target, props.rootDir);
}

function onHeaderClick() {
  if (props.editMode) return;
  // 非 git project は worktree カードを持たず畳む対象が無いため、ヘッダクリックを
  // 「rootDir を active dir に選択」に振り分ける。これが非 git project のファイラーを
  // 表示する唯一の経路（git repo は WtCard クリックが担う）。
  if (!isGitRepo.value) {
    emit("selectRoot", props.rootDir);
    return;
  }
  repoStore.toggleCollapsed(props.rootDir);
}
</script>

<template>
  <section ref="section" :data-active="active" class="_fx-panel mx-1 mb-2 flex flex-col rounded-lg">
    <!-- header は panel 幅 full-bleed の 1 行コントロール。padding は内側の button が持ち、
         focus ring / shine が行全体 = collapsed 時は panel 全体に掛かる。角丸は状態で
         変えず panel と同じ rounded-lg（展開時に上下で radius が混在するとタブ状の
         歪な形に見えるため、全周統一の pill にする）。 -->
    <header class="_fx-shine group/repo relative flex items-center rounded-lg text-foreground">
      <!-- clickable 部はネイティブ button。focus / Enter / Space の起動はブラウザが扱うため
           tabindex / keydown を自前実装しない (WtCard と同じ規約)。editMode 中は useSortable の
           ドラッグハンドルを兼ね、onHeaderClick が早期 return するので click は no-op になる。 -->
      <button
        ref="dragHandle"
        type="button"
        class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden focus-visible:ring-inset"
        :class="editMode ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'"
        :title="rootDir"
        :aria-label="headerAriaLabel"
        :aria-expanded="headerAriaExpanded"
        @click="onHeaderClick"
      >
        <RepoIcon :name="repoName" :owner="githubOwner" />
        <span class="min-w-0 flex-1 truncate text-sm font-semibold tracking-wide">
          {{ repoName }}
        </span>
      </button>
      <!-- 右側アクションクラスタ: 開閉 chevron + ⋮ menu を並べ、両方まとめて hover / focus-within で
           出す (WtCard の … と同一マテリアル)。absolute オーバーレイで flow から外すので icon / title を
           押さず、chevron 単独で右に浮くこともない。通常モード + git repo 限定
           (非 git は折りたたみ対象が無く、復元も gozd 製 worktree 向けのため)。 -->
      <div
        v-if="!editMode && isGitRepo"
        class="absolute inset-y-0 right-1.5 my-auto flex items-center gap-0.5 opacity-0 transition-opacity duration-100 group-focus-within/repo:opacity-100 group-hover/repo:opacity-100"
      >
        <button
          type="button"
          :aria-label="visiblyCollapsed ? 'Expand' : 'Collapse'"
          class="grid size-5 place-items-center rounded-sm bg-panel text-foreground shadow-md ring-1 ring-border hover:bg-element"
          @click.stop="repoStore.toggleCollapsed(rootDir)"
        >
          <IconLucideChevronDown
            class="size-3.5 text-foreground-muted transition-transform"
            :class="visiblyCollapsed && '-rotate-90'"
          />
        </button>
        <button
          type="button"
          aria-label="Open menu"
          class="grid size-5 place-items-center rounded-sm bg-panel text-foreground shadow-md ring-1 ring-border hover:bg-element"
          @click="onOpenMenu"
        >
          <IconLucideEllipsisVertical class="text-xs" />
        </button>
      </div>
      <button
        v-if="editMode"
        type="button"
        aria-label="Remove repository from window"
        title="Remove from window"
        class="mr-1.5 grid size-6 place-items-center rounded-sm text-destructive-text hover:bg-destructive-subtle hover:text-destructive-text"
        @click.stop="emit('removeRepo', rootDir)"
      >
        <IconLucideX class="text-sm" />
      </button>
    </header>

    <Transition
      enter-from-class="h-0"
      enter-active-class="overflow-hidden transition-[height] duration-200 ease-out"
      leave-active-class="overflow-hidden transition-[height] duration-200 ease-out"
      leave-to-class="h-0"
    >
      <div v-if="bodyVisible" class="[interpolate-size:allow-keywords]">
        <div class="flex flex-col gap-2 px-2 pt-1 pb-2">
          <WtCard
            v-for="wt in orderedWorktrees"
            :key="wt.path"
            :wt="wt"
            :root-dir="rootDir"
            :active="activeDir === wt.path"
            :focused-pty-id="getFocusedPtyId(wt.path)"
            @select-wt="emit('selectWt', $event)"
            @select-task="(w, t) => emit('selectTask', w, t)"
            @open-menu="(anchorEl, wt2) => emit('openWorktreeMenu', anchorEl, wt2, rootDir)"
            @open-task-menu="(anchorEl, t) => emit('openTaskMenu', anchorEl, t, rootDir)"
          />
          <button
            type="button"
            class="_fx-shine flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs text-foreground-low transition-colors hover:bg-element-hover hover:text-foreground disabled:cursor-not-allowed disabled:text-foreground-muted disabled:hover:bg-transparent disabled:hover:text-foreground-muted"
            :disabled="isCreating"
            @click="emit('addWorktree', rootDir)"
          >
            <component
              :is="isCreating ? IconLucideLoaderCircle : IconLucidePlus"
              class="size-3.5"
              :class="isCreating ? 'animate-spin' : ''"
            />
            <span>New worktree</span>
          </button>
        </div>
      </div>
    </Transition>
  </section>
</template>
