<doc lang="md">
1 worktree のカード。ヘッダ (branch 名 / server port バッジ / git status /
upstream ahead-behind / ⋮) と、Claude セッション行 (SessionList) を縦に並べる。
セッションが無い wt はヘッダのみ。

## グルーピング

「worktree とそこで動いたセッション群」を 1 つの単位として明示するため、カードは境界
(border + 内パディング) を持ち、セッションがある場合はヘッダとボディを divider で区切る。
ヘッダ = worktree identity ゾーン、ボディ = その worktree のセッション群ゾーンとして
構造で分離する。

ヘッダには icon を置かず branch 名のみで identity を示す。gutter に出る icon をセッション行の
claude state icon だけに限定することで、worktree identity (branch 名) とセッションの状態 (icon)
が別レイヤーに分かれ、複数種の icon が同一 gutter に並列して見分けづらくなる問題を解消する。

カード境界は `overflow-hidden` を使わない。active カードの `_fx-quest-active` が持つ
外周ブルーム (`box-shadow`) がクリップされて消えるため。内パディング `p-0.5` で内部 row
を角丸にし、row の hover 背景がカードの角丸境界とぶつからないようにする。

server port バッジは、その worktree の端末で LISTEN 中の dev server の port を表示する
(live なサーバーのみ)。詳細は docs/server.md。

## ハイライト

選択表現を 2 レベルで階層分離する。fill (青 capsule) は常にカード内 1 行だけ。

- **カード = アウトライン**: active worktree は border-primary + 外周グロー
  (`_fx-quest-active`) で示す。内部は塗らない。
- **行 = fill**: focus がある 1 行だけ `bg-primary-subtle` の capsule。focused PTY が
  セッションなら該当セッション行、セッションに focus が無い (wt の素のターミナル) なら header。

カード自体を青く塗ると focus 行の青 capsule と青ｘ青で潰れて「どの行か」が読めなく
なるため、塗りは行だけが持つ。所属 (active worktree であること) は card の outline が担う。
</doc>

<script setup lang="ts">
import type { WorktreeEntry } from "@gozd/rpc";
import { computed } from "vue";
import {
  type RepoWorktree,
  branchLabel as resolveBranchLabel,
  useRepoStore,
} from "../../../../shared/repo";
import { useServerStore } from "../../../server";
import { buildSessionRows, type SessionRow } from "../../../session";
import type { ClaudeState } from "../../../terminal";
import { displayClaudeState, useTerminalStore } from "../../../terminal";
import { computeStatusIcons, StatusIcons } from "../../../worktree";
import { hasChanges } from "../../utils";
import SessionList from "./SessionList.vue";
import IconLucideArrowDown from "~icons/lucide/arrow-down";
import IconLucideArrowUp from "~icons/lucide/arrow-up";
import IconLucideEllipsisVertical from "~icons/lucide/ellipsis-vertical";
import IconLucideServer from "~icons/lucide/server";

const props = defineProps<{
  wt: RepoWorktree;
  rootDir: string;
  active: boolean;
}>();

const emit = defineEmits<{
  selectWt: [wt: WorktreeEntry];
  selectSession: [row: SessionRow];
  openMenu: [anchorEl: HTMLElement, wt: WorktreeEntry];
  openSessionMenu: [anchorEl: HTMLElement, row: SessionRow];
}>();

const terminalStore = useTerminalStore();
const serverStore = useServerStore();
const repoStore = useRepoStore();

/** この worktree の端末で LISTEN 中のサーバー port (issue #768)。Claude status と同粒度のバッジ。 */
const livePorts = computed(() => serverStore.livePortsByWorktree(props.wt.path));

/**
 * wt 内の Claude 状態を集約したオーラ。複数セッションが同居する場合は
 * 緊急度の高い順 (asking > working > done) で 1 つに代表させる。
 */
const AURA_CLASS: Partial<Record<ClaudeState, string>> = {
  asking: "_fx-aura-asking",
  working: "_fx-aura-working",
  done: "_fx-aura-done",
};
const AURA_PRIORITY: ClaudeState[] = ["asking", "working", "done"];

const auraClass = computed<string | undefined>(() => {
  // displayClaudeState 経由で done + pendingWork を working として集約する（緑 aura を出さない）
  const states = terminalStore
    .getClaudeStatusesByDir(props.wt.path)
    .map((s) => displayClaudeState(s));
  const top = AURA_PRIORITY.find((state) => states.includes(state));
  return top === undefined ? undefined : AURA_CLASS[top];
});

const branchLabel = computed(() => resolveBranchLabel(props.wt.branch));

const statusIcons = computed(() => {
  if (!props.wt.gitStatuses) return [];
  return computeStatusIcons(props.wt.gitStatuses);
});

const sessionRows = computed(() =>
  buildSessionRows(
    props.wt.path,
    terminalStore.liveSessions,
    repoStore.sessionsForDir(props.rootDir, props.wt.path),
  ),
);

/**
 * header の capsule (青 fill) は「wt が active かつセッションに focus が無い」ときだけ。
 * セッションに focus があるときは該当行を fill するので、header まで fill すると
 * 同一カード内に青 fill が 2 つ並んで「どの行が focus か」が潰れる。fill は常に
 * 1 行だけ、という不変条件を保つ。active worktree であること自体は card の
 * border-primary + glow が示すため、header fill が消えても所属は分かる。
 */
const headerActive = computed(
  () =>
    props.active &&
    !sessionRows.value.live.some((row) =>
      terminalStore.isSessionFocused(props.wt.path, row.sessionId),
    ),
);

/** main worktree (= リポジトリ root) は git worktree remove 不可で、メニューに出せる項目が無い
 * （WorktreeMenu 側の出し分けと対）。 */
const canOpenMenu = computed(() => !props.wt.isMain);

const hasSessions = computed(
  () => sessionRows.value.live.length > 0 || sessionRows.value.inactive.length > 0,
);

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
    :data-wt-path="wt.path"
    class="flex flex-col gap-0.5 rounded-lg border p-0.5 transition-colors"
    :class="[active ? '_fx-quest-active border-primary' : 'border-border-subtle', auraClass]"
  >
    <div class="group/wt relative">
      <button
        type="button"
        :data-active="headerActive"
        class="_fx-shine flex w-full items-center gap-2 rounded-md px-2 py-0.5 text-left text-foreground-low transition-colors hover:bg-element-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden focus-visible:ring-inset data-[active=true]:bg-primary-subtle data-[active=true]:hover:bg-primary-subtle-hover"
        @click="onHeaderClick"
      >
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
        v-if="canOpenMenu"
        type="button"
        aria-label="Open menu"
        class="absolute inset-y-0 right-1 my-auto grid size-5 place-items-center rounded-sm bg-panel text-foreground opacity-0 shadow-md ring-1 ring-border transition-opacity duration-100 group-focus-within/wt:opacity-100 group-hover/wt:opacity-100 hover:bg-element hover:text-foreground"
        @click="onMenuClick"
      >
        <IconLucideEllipsisVertical class="text-xs" />
      </button>
    </div>

    <div v-if="hasSessions" class="border-t border-border-subtle py-0.5">
      <SessionList
        :rows="sessionRows"
        :dir="wt.path"
        :active="active"
        @select="(row) => emit('selectSession', row)"
        @open-menu="(anchorEl, row) => emit('openSessionMenu', anchorEl, row)"
      />
    </div>
  </article>
</template>
