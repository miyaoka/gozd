<doc lang="md">
全 repo のセッションを平らに並べる、サイドバーの状態別の表示（docs/session.md）。
worktree の階層表示と切り替えて使い、両方を同時には出さない。

## 分け方

「Active」（端末が開いている）と「Inactive」（開いていない）の 2 つのパネルに分ける。
待機中の状態アイコンと直近の相対時刻はどちらも緑で、同じ面に並べると見分けにくいため、
見出しだけでなく面で区切る。

状態ごとの見出しは付けない。状態は行のアイコンで分かるため、見出しを重ねると行より見出しが
多くなる。空の側はパネルごと出さない。

## セッションが主体

行の主役はセッションのタイトルで、どこの作業かは添えるだけにする。ブランチは出さない。

- Active は repo ごとにまとめ、repo は小さいアイコンと名前の見出しで示す
- Inactive は repo でまとめず、行のタイトルの下に小さい repo アイコンと repo 名を添える。
  過去のセッションはタイトルだけではどこの作業か分からないため

## 並び

Active は注意が要る状態から順（要対応 → 完了・未読 → 実行中 → 待機）に並べ、同じ状態の中は
状態に入った時刻の新しい順。repo の並びは、その repo で最も先に来る行で決まる。常時表示される
面なので、並びが変わるきっかけを状態の変化に限り、付随データの更新で行を動かさない。

Inactive は最終活動の新しい順。全 repo の過去のセッションが対象になるため、直近の数件だけを
出し、「Show more」で一定件数ずつ広げる。

## 母集団

repo プール全体（アクティブな repo list で絞らない）。窓口はプールの外なので含まれない。
</doc>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useRepoStore } from "../../../../shared/repo";
import { RepoIcon } from "../../../repo-icon";
import { collectPoolSessionRows, type PoolSessionRow } from "../../../session";
import { useTerminalStore } from "../../../terminal";
import { useWorktreeStore } from "../../../worktree";
import { SessionRow } from "../worktree";
import { groupByStatus } from "./statusGroups";

/** 端末の開いていないセッションを最初に出す件数 */
const INACTIVE_INITIAL_COUNT = 10;
/** 「Show more」1 回で広げる件数 */
const INACTIVE_PAGE_SIZE = 10;

const emit = defineEmits<{
  select: [row: PoolSessionRow];
  openMenu: [anchorEl: HTMLElement, row: PoolSessionRow];
}>();

const repoStore = useRepoStore();
const terminalStore = useTerminalStore();
const worktreeStore = useWorktreeStore();

const groups = computed(() =>
  groupByStatus(
    collectPoolSessionRows(
      repoStore.poolDirs,
      repoStore.repos,
      (rootDir) => repoStore.sessionsOf(rootDir),
      terminalStore.liveSessions,
    ),
  ),
);

const inactiveLimit = ref(INACTIVE_INITIAL_COUNT);
const visibleInactive = computed(() => groups.value.inactive.slice(0, inactiveLimit.value));
const hiddenCount = computed(() => groups.value.inactive.length - visibleInactive.value.length);
/** 初期の件数より多く出しているか。畳む操作を出す条件 */
const canCollapse = computed(() => visibleInactive.value.length > INACTIVE_INITIAL_COUNT);

function showMore() {
  inactiveLimit.value += INACTIVE_PAGE_SIZE;
}

function showLess() {
  inactiveLimit.value = INACTIVE_INITIAL_COUNT;
}

/** focus がある 1 行。選択中の dir の focus 先だけを見る（各 dir の focus は履歴として残るため） */
function isActive(row: PoolSessionRow): boolean {
  return worktreeStore.dir === row.dir && terminalStore.isSessionFocused(row.dir, row.sessionId);
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <section v-if="groups.active.length > 0" class="_fx-panel flex flex-col rounded-lg">
      <h3 class="px-2.5 py-2 text-sm font-semibold tracking-wide">Active</h3>
      <div class="flex flex-col gap-2 px-2 pb-2">
        <div v-for="group in groups.active" :key="group.rootDir" class="flex flex-col">
          <div class="flex items-center gap-1.5 px-2 py-0.5 text-xs text-foreground-low">
            <RepoIcon :name="group.repoName" :owner="group.owner" size="sm" />
            <span class="truncate">{{ group.repoName }}</span>
          </div>
          <SessionRow
            v-for="row in group.rows"
            :key="row.sessionId"
            :row="row"
            :active="isActive(row)"
            show-live-age
            @select="emit('select', row)"
            @open-menu="(anchorEl) => emit('openMenu', anchorEl, row)"
          />
        </div>
      </div>
    </section>

    <section v-if="visibleInactive.length > 0" class="_fx-panel flex flex-col rounded-lg">
      <h3 class="px-2.5 py-2 text-sm font-semibold tracking-wide">Inactive</h3>
      <div class="flex flex-col px-2 pb-2">
        <SessionRow
          v-for="row in visibleInactive"
          :key="row.sessionId"
          :row="row"
          :active="false"
          :repo="{ name: row.repoName, owner: row.owner }"
          @select="emit('select', row)"
          @open-menu="(anchorEl) => emit('openMenu', anchorEl, row)"
        />
        <div v-if="hiddenCount > 0 || canCollapse" class="flex gap-1">
          <button
            v-if="hiddenCount > 0"
            type="button"
            class="rounded-md px-2 py-0.5 text-left text-xs text-foreground-low transition-colors hover:bg-element-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden focus-visible:ring-inset"
            @click="showMore"
          >
            Show more ({{ hiddenCount }})
          </button>
          <button
            v-if="canCollapse"
            type="button"
            class="rounded-md px-2 py-0.5 text-left text-xs text-foreground-low transition-colors hover:bg-element-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden focus-visible:ring-inset"
            @click="showLess"
          >
            Show less
          </button>
        </div>
      </div>
    </section>

    <p
      v-if="groups.active.length === 0 && groups.inactive.length === 0"
      class="px-4 py-8 text-center text-xs text-foreground-muted"
    >
      No sessions
    </p>
  </div>
</template>
