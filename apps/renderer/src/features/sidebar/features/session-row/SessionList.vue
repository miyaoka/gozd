<doc lang="md">
1 つの作業ディレクトリ（worktree / 非 git project の root）の Claude セッション行を並べる。
gozd はセッションを管理する記録を持たず、端末とセッションの対応と Claude のセッションログから
行を組み立てる（`buildSessionRows`）。

## 並び順

端末が開いているセッションを上に、開いていないセッションを下に並べ、見出しで区切らない。
それぞれ最終活動の新しい順。端末を閉じたセッションは、ログの最終更新が最も新しいため
下の先頭に移り、閉じても見失わない。

端末の開いていないセッションは過去のもの全てが対象になるため、直近の数件だけを出す。
「Show more」は一定件数ずつ広げ、全件を一度に開かない（件数に上限が無く、一度に開くと
サイドバーが 1 つの worktree で埋まる）。広げた後は「Show less」で初期の件数へ畳める。

## ハイライト

fill (青 capsule) は focus がある 1 行だけ。active でないカードでは出さない（各 dir の
focusedLeafId は履歴として残るため、active 条件を噛ませないと過去訪問した全 dir で点く）。
</doc>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { DirSessionRows, SessionRow as SessionRowData } from "../../../session";
import { useTerminalStore } from "../../../terminal";
import SessionRow from "./SessionRow.vue";

/** 端末の開いていないセッションを最初に出す件数 */
const INACTIVE_INITIAL_COUNT = 3;
/** 「Show more」1 回で広げる件数 */
const INACTIVE_PAGE_SIZE = 10;

const props = defineProps<{
  rows: DirSessionRows;
  dir: string;
  active: boolean;
}>();

const emit = defineEmits<{
  select: [row: SessionRowData];
  openMenu: [anchorEl: HTMLElement, row: SessionRowData];
}>();

const terminalStore = useTerminalStore();

const inactiveLimit = ref(INACTIVE_INITIAL_COUNT);

const visibleInactive = computed(() => props.rows.inactive.slice(0, inactiveLimit.value));
const hiddenCount = computed(() => props.rows.inactive.length - visibleInactive.value.length);
/** 初期の件数より多く出しているか。畳む操作を出す条件 */
const canCollapse = computed(() => visibleInactive.value.length > INACTIVE_INITIAL_COUNT);

function showMore() {
  inactiveLimit.value += INACTIVE_PAGE_SIZE;
}

function showLess() {
  inactiveLimit.value = INACTIVE_INITIAL_COUNT;
}

const visibleRows = computed(() => [...props.rows.live, ...visibleInactive.value]);

/** focus がある 1 行。判定の SSOT は `terminalStore.isSessionFocused` */
const focusedSessionId = computed(() => {
  if (!props.active) return undefined;
  return props.rows.live.find((row) => terminalStore.isSessionFocused(props.dir, row.sessionId))
    ?.sessionId;
});
</script>

<template>
  <div v-if="visibleRows.length > 0" class="flex flex-col">
    <SessionRow
      v-for="row in visibleRows"
      :key="row.sessionId"
      :row="row"
      :active="focusedSessionId === row.sessionId"
      @select="(r) => emit('select', r)"
      @open-menu="(anchorEl, r) => emit('openMenu', anchorEl, r)"
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
</template>
