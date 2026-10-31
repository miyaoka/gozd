<script setup lang="ts">
import { computed, ref, watch } from "vue";
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

// 選択を外した dir は端末の開いていない行を出さなくなるため、広げた件数も初期に戻す。
// 行が残って mount され続ける dir でも、unmount される dir と同じく次の選択で初期の件数から出す
watch(
  () => props.active,
  (active) => {
    if (!active) inactiveLimit.value = INACTIVE_INITIAL_COUNT;
  },
);

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
