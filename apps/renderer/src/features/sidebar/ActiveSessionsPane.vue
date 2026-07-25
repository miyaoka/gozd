<doc lang="md">
サイドバー下段の「いま動いている Claude セッション」一覧ペイン。

## repo 一覧の複製にしない

上段の repo 一覧と同じ `RepoSection` / `WtCard` を絞り込んで出す方式は破棄した。同じ形の
カードが上下に並ぶと、境界線・余白・背景差をいくら足しても「同じカード列の続き」としか
読めない（NN/g: 視覚的に同一な要素は距離が離れても同じ group として知覚される）。

代わりに **セッション専用の行フォーマット**にする。VS Code の Open Editors が Explorer の
ツリーではなく flat list であり、Copilot の Agents window がセッション行を workspace で
グルーピングするのと同じ考え方で、「いま動いているもの」は navigation ツリーとは別の形を持つ。

- グループ = worktree（`repoName · branch` の 1 行ラベル）。repo → worktree → task の
  3 階層を 2 階層に圧縮する。狭いサイドバーで見出しを 2 段積むと、行 1 本あたり見出し 2 本の
  比率になり一覧として読めない
- 行 = live session を持つ task（`TaskRow` を上段と共有）。行の形だけは共有して操作と状態
  表現の SSOT を保ち、囲い / 見出し / 密度で上段と差を付ける

## 区切り

ペイン全体を border + 角丸 + `bg-panel` の 1 枚のプレートにして左右にも余地を残す
（NN/g: **common region は proximity / similarity を上回る最も強い grouping cue**）。
full-bleed のままだと囲いが成立せず、`bg-background`(L 0.231) と `bg-panel`(L 0.264) の
差 ΔL 0.033 は単独では知覚できない。

ヘッダはプレート内の title bar（`bg-element` の帯）。VS Code の `sideBarSectionHeader` も
既定では border ではなく塗りで section を区切る。

## count

`claudeActiveLeafIds.length`（= claude タイルの数）を出す。行数ではなくタイル数を出すのは、
task に紐づく前のセッションも「動いている 1 つ」として数えるため。
</doc>

<script setup lang="ts">
import type { Task, WorktreeEntry } from "@gozd/rpc";
import { useTerminalStore } from "../terminal";
import { useWorktreeStore } from "../worktree";
import type { ActiveSessionGroup } from "./activeSessions";
import { TaskRow } from "./features/worktree";
import { useActiveSessions } from "./useActiveSessions";
import IconLucideBot from "~icons/lucide/bot";

const emit = defineEmits<{
  selectDir: [dir: string];
  selectWt: [wt: WorktreeEntry];
  selectTask: [wt: WorktreeEntry, task: Task];
  openTaskMenu: [anchorEl: HTMLElement, task: Task, rootDir: string];
}>();

const terminalStore = useTerminalStore();
const worktreeStore = useWorktreeStore();
const groups = useActiveSessions();

/** グループラベルのクリック。git repo は worktree 選択、非 git project は dir 選択に振り分ける */
function onSelectGroup(group: ActiveSessionGroup) {
  if (group.worktree === undefined) {
    emit("selectDir", group.dir);
    return;
  }
  emit("selectWt", group.worktree);
}

/** 行のクリック。非 git project は task を持たない（worktree undefined の group は行が 0 本） */
function onSelectTask(group: ActiveSessionGroup, task: Task) {
  if (group.worktree === undefined) return;
  emit("selectTask", group.worktree, task);
}

/** 行の fill は focus のある 1 本だけ。active worktree 以外の focus 履歴を拾わないよう dir も見る */
function isFocused(dir: string, sessionId: string): boolean {
  if (worktreeStore.dir !== dir) return false;
  const focusedLeafId = terminalStore.layoutsByDir[dir]?.focusedLeafId;
  if (focusedLeafId === undefined) return false;
  return terminalStore.getPtyId(focusedLeafId) === terminalStore.getPtyIdBySessionId(sessionId);
}
</script>

<template>
  <div
    class="flex size-full flex-col overflow-hidden rounded-lg border border-border bg-panel text-foreground"
  >
    <div class="flex h-7 shrink-0 items-center gap-1.5 border-b border-border bg-element px-2">
      <IconLucideBot class="size-3.5 shrink-0 text-foreground-low" />
      <span class="min-w-0 flex-1 truncate text-xs font-semibold">Active sessions</span>
      <span class="text-xs text-foreground-low tabular-nums">
        {{ terminalStore.claudeActiveLeafIds.length }}
      </span>
    </div>

    <!-- session が 0 件のときは body ごと出さない（親がプレートをヘッダ高さに畳む）。
         「0 件である」ことはヘッダの count が伝えるので、空の一覧本体は出さない -->
    <div
      v-if="groups.length > 0"
      class="_thin-scrollbar flex min-h-0 flex-1 flex-col overflow-y-scroll"
    >
      <section v-for="group in groups" :key="group.dir" class="flex flex-col">
        <!-- グループラベル: repo 名 + branch を 1 行に畳む。行より 1 段小さく muted にして、
             見出しと行の主従を密度で示す（囲いは既にペイン外周が担っているので枠は付けない） -->
        <button
          type="button"
          class="flex w-full items-center px-2 py-0.5 text-left text-foreground-muted transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden focus-visible:ring-inset"
          :class="worktreeStore.dir === group.dir && 'text-primary-text'"
          :title="group.dir"
          @click="onSelectGroup(group)"
        >
          <span class="min-w-0 truncate text-[10px] tracking-wide">{{ group.label }}</span>
        </button>
        <TaskRow
          v-for="entry in group.entries"
          :key="entry.task.id"
          :task="entry.task"
          :status="entry.status"
          :active="isFocused(group.dir, entry.task.sessionId)"
          @select="(t) => onSelectTask(group, t)"
          @open-menu="(anchorEl, t) => emit('openTaskMenu', anchorEl, t, group.rootDir)"
        />
      </section>
    </div>
  </div>
</template>
