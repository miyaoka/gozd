<doc lang="md">
1 worktree のカード。ヘッダ (branch icon / branch / server port バッジ / git status /
upstream ahead-behind / ⋮) と、Task 行 (TaskRow) を縦に並べる。task が無い wt はヘッダのみ。

## グルーピング

「worktree とそれに属する task 群」を 1 つの単位として明示するため、カードは境界
(border + 内パディング) を持ち、task がある場合はヘッダとボディを divider で区切る。
ヘッダ = worktree identity ゾーン、ボディ = その worktree に属する task 群ゾーンとして
構造で分離する。これにより branch/home icon (identity) と claude state icon (task の状態)
が別ゾーンに分かれ、同一 gutter に並列して見分けづらくなる問題を解消する。

カード境界は `overflow-hidden` を使わない。active カードの `_fx-quest-active` が持つ
外周ブルーム (`box-shadow`) がクリップされて消えるため。内パディング `p-0.5` で内部 row
を角丸にし、row の hover 背景がカードの角丸境界とぶつからないようにする。

server port バッジは、その worktree の端末で LISTEN 中の dev server の port を表示する
(issue #768、live のみ)。詳細は [docs/server.md](../../../../../../../docs/server.md)。

Task は PR/issue picker や手動操作で永続的に作られ、Claude session は
`task.sessionId` に attach する短命属性として扱う。session 未紐付けの task
(`sessionId == ""`) も表示対象で、行をクリックすると素の `claude` が起動する。

## ハイライト

選択表現を 2 レベルで階層分離する。fill (青 capsule) は常にカード内 1 行だけ。

- **カード = アウトライン**: active worktree は border-primary + 外周グロー
  (`_fx-quest-active`) で示す。内部は塗らない。
- **行 = fill**: focus がある 1 行だけ `bg-primary-subtle` の capsule。focused PTY が
  task なら該当 task 行、task に focus が無い (wt の素のターミナル) なら header。

カード自体を青く塗ると focus 行の青 capsule と青ｘ青で潰れて「どの行か」が読めなく
なるため、塗りは行だけが持つ。所属 (active worktree であること) は card の outline が担う。

## 並び順

task は `task.createdAt` 昇順 (append 順) で固定。新しい task は末尾に追加され、
既存 task の位置は動かない。state や lastActivityAt は動的なためソートキーに
混ぜない。位置の安定性を優先し、状態は行頭アイコンと相対時刻表示で示す責務
分担。wt の並び (`RepoSection.orderedWorktrees` の `git worktree list` append 順)
と同じ方針。
</doc>

<script setup lang="ts">
import type { Task, WorktreeEntry } from "@gozd/proto";
import { computed } from "vue";
import { useServerStore } from "../../../server";
import type { ClaudeState, ClaudeStatus } from "../../../terminal";
import { useTerminalStore } from "../../../terminal";
import { computeStatusIcons, StatusIcons } from "../../../worktree";
import { branchLabel as resolveBranchLabel, hasChanges } from "../../utils";
import TaskRow from "./TaskRow.vue";
import IconLucideArrowDown from "~icons/lucide/arrow-down";
import IconLucideArrowUp from "~icons/lucide/arrow-up";
import IconLucideEllipsisVertical from "~icons/lucide/ellipsis-vertical";
import IconLucideGitBranch from "~icons/lucide/git-branch";
import IconLucideHouse from "~icons/lucide/house";
import IconLucideServer from "~icons/lucide/server";

const props = defineProps<{
  wt: WorktreeEntry;
  rootDir: string;
  active: boolean;
  focusedPtyId: number | undefined;
}>();

const emit = defineEmits<{
  selectWt: [wt: WorktreeEntry];
  selectTask: [wt: WorktreeEntry, task: Task];
  openMenu: [anchorEl: HTMLElement, wt: WorktreeEntry];
  openTaskMenu: [anchorEl: HTMLElement, task: Task];
}>();

const terminalStore = useTerminalStore();
const serverStore = useServerStore();

/** この worktree の端末で LISTEN 中のサーバー port (issue #768)。Claude status と同粒度のバッジ。 */
const livePorts = computed(() => serverStore.livePortsByWorktree(props.wt.path));

/**
 * wt 内の Claude 状態を集約したオーラ。複数 task が同居する場合は
 * 緊急度の高い順 (asking > working > done) で 1 つに代表させる。
 */
const AURA_CLASS: Partial<Record<ClaudeState, string>> = {
  asking: "_fx-aura-asking",
  working: "_fx-aura-working",
  done: "_fx-aura-done",
};
const AURA_PRIORITY: ClaudeState[] = ["asking", "working", "done"];

const auraClass = computed<string | undefined>(() => {
  const states = terminalStore.getClaudeStatusesByDir(props.wt.path).map((s) => s.state);
  const top = AURA_PRIORITY.find((state) => states.includes(state));
  return top === undefined ? undefined : AURA_CLASS[top];
});

const branchIcon = computed(() => (props.wt.isMain ? IconLucideHouse : IconLucideGitBranch));
const branchLabel = computed(() => resolveBranchLabel(props.wt.branch));

const statusIcons = computed(() => {
  if (!props.wt.gitStatuses) return [];
  return computeStatusIcons(props.wt.gitStatuses);
});

interface TaskWithStatus {
  task: Task;
  status: ClaudeStatus | undefined;
  ptyId: number | undefined;
}

/**
 * ソートは `task.createdAt` (静的) のみ。state や lastActivityAt のような
 * 動的値をキーに混ぜると Claude の活動ごとに行位置が入れ替わり、ユーザーが
 * 「どこに何の task があるか」を空間記憶で辿れなくなる。位置は固定、状態は
 * 行頭アイコンと相対時刻で表現する責務分担。
 */
const tasksWithStatus = computed<TaskWithStatus[]>(() => {
  // task ≠ session 設計: sessionId が空 (PR/issue 由来で未起動 / SessionEnd で切り離し済み)
  // の task は status / ptyId 共に undefined になる。サイドバークリック時に素の claude を
  // 起動する分岐は SidebarPane.onSelectTask 側で扱う。
  const list = props.wt.tasks.map<TaskWithStatus>((task) => ({
    task,
    status:
      task.sessionId === "" ? undefined : terminalStore.getClaudeStatusBySessionId(task.sessionId),
    ptyId: task.sessionId === "" ? undefined : terminalStore.getPtyIdBySessionId(task.sessionId),
  }));
  return list.sort((a, b) => Date.parse(a.task.createdAt) - Date.parse(b.task.createdAt));
});

/**
 * wt 内のいずれかの task が focused PTY を持っているか。
 * active wt 以外では capsule を出してはいけない。各 wt の layoutsByDir[dir].
 * focusedLeafId は履歴として残るため、active 条件を噛ませないと過去訪問した
 * 全 wt で task に capsule が点いてしまう。
 */
const focusedTaskId = computed(() => {
  if (!props.active) return undefined;
  const focusedPty = props.focusedPtyId;
  if (focusedPty === undefined) return undefined;
  const found = tasksWithStatus.value.find((entry) => entry.ptyId === focusedPty);
  return found?.task.id;
});

/**
 * header の capsule (青 fill) は「wt が active かつ task に focus が無い」ときだけ。
 * task に focus があるときは該当 task 行を fill するので、header まで fill すると
 * 同一カード内に青 fill が 2 つ並んで「どの行が focus か」が潰れる。fill は常に
 * 1 行だけ、という不変条件を保つ。active worktree であること自体は card の
 * border-primary + glow が示すため、header fill が消えても所属は分かる。
 */
const headerActive = computed(() => props.active && focusedTaskId.value === undefined);

/** main worktree (= リポジトリ root) は git worktree remove 不可。現状メニュー項目は Remove のみ。 */
const canRemove = computed(() => !props.wt.isMain);

function onMenuClick(event: MouseEvent) {
  event.stopPropagation();
  const target = event.currentTarget;
  if (target instanceof HTMLElement) emit("openMenu", target, props.wt);
}

function onHeaderClick() {
  emit("selectWt", props.wt);
}
</script>

<template>
  <article
    :data-active="active"
    class="rounded-lg border p-0.5 transition-colors"
    :class="[active ? '_fx-quest-active border-primary' : 'border-border-subtle', auraClass]"
  >
    <div class="group/wt relative">
      <button
        type="button"
        :data-active="headerActive"
        class="_fx-shine flex w-full items-center gap-2 rounded-md px-2 py-0.5 text-left text-foreground-low transition-colors hover:bg-element-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden focus-visible:ring-inset data-[active=true]:bg-primary-subtle data-[active=true]:hover:bg-primary-subtle-hover"
        @click="onHeaderClick"
      >
        <span class="grid size-4 shrink-0 place-items-center" aria-hidden="true">
          <component :is="branchIcon" class="size-3.5" />
        </span>
        <span class="flex-1 truncate text-left text-xs font-medium">{{ branchLabel }}</span>
        <span
          v-if="livePorts.length > 0"
          class="flex items-center gap-0.5 text-[10px] text-success-text tabular-nums"
          :title="`Listening ports: ${livePorts.join(', ')}`"
        >
          <IconLucideServer class="size-3" />
          <span>{{ livePorts.join(" ") }}</span>
        </span>
        <span
          v-if="wt.gitStatuses && hasChanges(wt.gitStatuses)"
          class="flex items-center justify-end gap-1 text-xs"
        >
          <StatusIcons :entries="statusIcons" />
        </span>
        <span
          v-if="wt.upstream && (wt.upstream.ahead > 0 || wt.upstream.behind > 0)"
          class="flex items-center gap-1 text-[10px] tabular-nums"
          :title="`ahead ${wt.upstream.ahead} / behind ${wt.upstream.behind} vs upstream`"
        >
          <!-- ahead = local 進行 (緑) / behind = remote 進行 (赤)。filer の git status 色規約に揃える -->
          <span v-if="wt.upstream.ahead > 0" class="flex items-center gap-0.5 text-success-text">
            <IconLucideArrowUp class="size-3" />
            <span>{{ wt.upstream.ahead }}</span>
          </span>
          <span
            v-if="wt.upstream.behind > 0"
            class="flex items-center gap-0.5 text-destructive-text"
          >
            <IconLucideArrowDown class="size-3" />
            <span>{{ wt.upstream.behind }}</span>
          </span>
        </span>
      </button>
      <button
        v-if="canRemove"
        type="button"
        aria-label="Open menu"
        class="absolute inset-y-0 right-1 my-auto grid size-5 place-items-center rounded-sm bg-panel text-foreground opacity-0 shadow-md ring-1 ring-border transition-opacity duration-100 group-focus-within/wt:opacity-100 group-hover/wt:opacity-100 hover:bg-element hover:text-foreground"
        @click="onMenuClick"
      >
        <IconLucideEllipsisVertical class="text-xs" />
      </button>
    </div>

    <div v-if="tasksWithStatus.length > 0" class="mt-0.5 border-t border-border-subtle pt-0.5">
      <TaskRow
        v-for="entry in tasksWithStatus"
        :key="entry.task.id"
        :task="entry.task"
        :status="entry.status"
        :active="focusedTaskId === entry.task.id"
        @select="(t) => emit('selectTask', wt, t)"
        @open-menu="(anchorEl, t) => emit('openTaskMenu', anchorEl, t)"
      />
    </div>
  </article>
</template>
