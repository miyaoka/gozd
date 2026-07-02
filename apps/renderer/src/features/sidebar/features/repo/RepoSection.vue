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

## ハイライト

active worktree を所有する repo は section 枠を薄い primary 線 + 浮き上がる影で示す
(`._fx-panel[data-active]`)。塗り / グローは持たせず、wt カードの border-primary + 外周
グローより弱くする。同じ青でも「枠線 (repo) < 枠線 + グロー (wt)」で主従が分かれ、wt
ハイライトが repo 枠に埋もれない。
</doc>

<script setup lang="ts">
import { useSortable } from "@dnd-kit/vue/sortable";
import type { Task, WorktreeEntry } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { computed, ref, useTemplateRef, watch } from "vue";
import { useNotificationStore } from "../../../../shared/notification";
import { useRepoStore } from "../../../../shared/repo";
import { rpcGitGithubIdentity } from "../../rpc";
import { WtCard } from "../worktree";
import RepoIcon from "./RepoIcon.vue";
import IconLucideChevronDown from "~icons/lucide/chevron-down";
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
}>();

const repoStore = useRepoStore();

const repo = computed(() => repoStore.repos[props.rootDir]);
const repoName = computed(() => repo.value?.repoName ?? props.rootDir);
const isGitRepo = computed(() => repo.value?.isGitRepo ?? false);
const collapsed = computed(() => repoStore.isCollapsed(props.rootDir));

const active = computed(() => repoStore.selectedRootDir === props.rootDir);

const notify = useNotificationStore();

/** GitHub owner (org / 個人ユーザー)。非 github.com remote / remote 未設定 / 未取得は空文字 */
const githubOwner = ref("");

// rootDir は v-for の :key で instance に固定だが、isGitRepo は hydrate 経路
// (repo 未登録 → addRepo) で false → true に変わり得るため watch で拾う。
// owner は remote URL のローカル parse (外部通信なし) なので都度取得してよい。
watch(
  [() => props.rootDir, isGitRepo],
  async ([dir, git]) => {
    githubOwner.value = "";
    if (!git) return;
    const result = await tryCatch(rpcGitGithubIdentity({ dir }));
    // 稀な rootDir 差し替えで古いレスポンスを採用しない
    if (dir !== props.rootDir) return;
    if (!result.ok) {
      // launch failure は git CLI 解決失敗 (PATH 不在等) のみ。remote 未設定 / 非 github は
      // native 側で空文字 + stderr ログに倒すため、ここには来ない。
      notify.error("Failed to load GitHub identity", result.error);
      return;
    }
    githubOwner.value = result.value.owner;
  },
  { immediate: true },
);

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
  <section
    ref="section"
    :data-active="active"
    class="_fx-panel mx-1 mb-2 flex flex-col gap-2 rounded-lg p-2"
  >
    <header
      class="_fx-hud-header _fx-shine group/repo flex items-center gap-2 rounded-md px-1.5 py-1 text-foreground"
    >
      <!-- clickable 部はネイティブ button。focus / Enter / Space の起動はブラウザが扱うため
           tabindex / keydown を自前実装しない (WtCard と同じ規約)。editMode 中は useSortable の
           ドラッグハンドルを兼ね、onHeaderClick が早期 return するので click は no-op になる。 -->
      <button
        ref="dragHandle"
        type="button"
        class="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden focus-visible:ring-inset"
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
        <IconLucideChevronDown
          v-if="isGitRepo"
          class="size-3.5 shrink-0 text-foreground-muted transition-transform"
          :class="visiblyCollapsed && '-rotate-90'"
        />
      </button>
      <button
        v-if="editMode"
        type="button"
        aria-label="Remove repository from window"
        title="Remove from window"
        class="grid size-6 place-items-center rounded-sm text-destructive-text hover:bg-destructive-subtle hover:text-destructive-text"
        @click.stop="emit('removeRepo', rootDir)"
      >
        <IconLucideX class="text-sm" />
      </button>
    </header>

    <div v-if="isGitRepo && !visiblyCollapsed" class="flex flex-col gap-2">
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
  </section>
</template>
