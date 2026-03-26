<doc lang="md">
Reusable quick pick dialog for selecting an item from a filterable list.

## Behavior

- Opened via `useQuickPick().show()` (module singleton composable)
- Filters items by substring match on label (separators are included if adjacent selectable items match)
- Arrow keys navigate selectable items (separators are skipped), Enter accepts, Escape cancels
- `onHighlight` fires with 200ms debounce for live preview
- `onAccept` fires on Enter/click, `onCancel` on Escape/backdrop
- Positioned at top-center of the viewport (same as CommandPalette)
</doc>

<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { isIMEActive, useContextKeys } from "../../../../shared/command";
import { useListNavigation } from "../../useListNavigation";
import { useDialog } from "./useDialog";
import { useQuickPick } from "./useQuickPick";
import type { QuickPickItem } from "./useQuickPick";

const contextKeys = useContextKeys();
const { Dialog, show: showDialog, close: closeDialog, isOpen } = useDialog();
const { currentOptions, showSignal } = useQuickPick();

const inputRef = useTemplateRef<HTMLInputElement>("input");
const listRef = useTemplateRef<HTMLUListElement>("list");
const query = ref("");
let accepted = false;

const items = computed(() => currentOptions.value?.items ?? []);

const filteredItems = computed((): QuickPickItem[] => {
  const q = query.value.toLowerCase();
  if (q === "") return items.value;

  // フィルタ時はセパレータを除外し、マッチするアイテムのみ返す
  return items.value.filter((item) => !item.separator && item.label.toLowerCase().includes(q));
});

/** フィルタ結果内の選択可能アイテムのインデックス一覧 */
const selectableIndices = computed(() => {
  const indices: number[] = [];
  for (const [i, item] of filteredItems.value.entries()) {
    if (!item.separator) indices.push(i);
  }
  return indices;
});

const itemCount = computed(() => filteredItems.value.length);
const { selectedIndex, move, movePage, reset, scrollToSelected } = useListNavigation({
  listRef,
  itemCount,
  selectableIndices,
});

/**
 * filteredItems 変更時に選択を先頭にリセットする。
 * ただし showSignal 処理中は activeIndex を優先するため抑制する。
 */
let suppressFilterReset = false;
watch(
  filteredItems,
  () => {
    if (suppressFilterReset) return;
    reset();
  },
  { flush: "sync" },
);

/** Open dialog when showSignal changes */
watch(showSignal, () => {
  if (currentOptions.value === undefined) return;
  suppressFilterReset = true;
  query.value = "";
  const initial = currentOptions.value.activeIndex ?? 0;
  reset(selectableIndices.value.includes(initial) ? initial : undefined);
  suppressFilterReset = false;
  accepted = false;
  showDialog();
  nextTick(() => {
    inputRef.value?.focus();
    scrollToSelected();
  });
});

/** Sync context key with dialog open state */
watch(isOpen, (open) => {
  contextKeys.set("quickPickVisible", open);
});

const HIGHLIGHT_DEBOUNCE_MS = 200;
let highlightTimeout: ReturnType<typeof setTimeout> | undefined;

watch(selectedIndex, (idx) => {
  if (currentOptions.value === undefined) return;
  const item = filteredItems.value[idx];
  if (item === undefined || item.separator) return;

  if (highlightTimeout !== undefined) {
    clearTimeout(highlightTimeout);
  }
  const options = currentOptions.value;
  highlightTimeout = setTimeout(() => {
    highlightTimeout = undefined;
    options.onHighlight(item);
  }, HIGHLIGHT_DEBOUNCE_MS);
});

function accept() {
  if (currentOptions.value === undefined) return;
  const item = filteredItems.value[selectedIndex.value];
  if (item === undefined || item.separator) return;
  accepted = true;
  clearHighlightTimeout();
  closeDialog();
  currentOptions.value.onAccept(item);
}

function cancel() {
  clearHighlightTimeout();
  closeDialog();
  if (!accepted && currentOptions.value !== undefined) {
    currentOptions.value.onCancel();
  }
}

function clearHighlightTimeout() {
  if (highlightTimeout !== undefined) {
    clearTimeout(highlightTimeout);
    highlightTimeout = undefined;
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (isIMEActive(e)) return;
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      move(1);
      break;
    case "ArrowUp":
      e.preventDefault();
      move(-1);
      break;
    case "PageDown":
      e.preventDefault();
      movePage(1);
      break;
    case "PageUp":
      e.preventDefault();
      movePage(-1);
      break;
    case "Enter":
      e.preventDefault();
      accept();
      break;
  }
}
</script>

<template>
  <Dialog class="_quick-pick-dialog" @close="cancel" @keydown="handleKeydown">
    <div class="w-[480px] overflow-hidden rounded-lg border border-zinc-600 bg-zinc-800 shadow-2xl">
      <div class="border-b border-zinc-700 p-2">
        <input
          ref="input"
          v-model="query"
          type="text"
          :placeholder="currentOptions?.placeholder ?? 'Select an item...'"
          aria-label="Filter items"
          class="w-full bg-transparent px-2 py-1 text-sm text-zinc-200 outline-none placeholder:text-zinc-500"
        />
      </div>
      <ul v-if="filteredItems.length > 0" ref="list" class="max-h-[300px] overflow-y-auto py-1">
        <template v-for="(item, i) in filteredItems" :key="item.label">
          <!-- セパレータ行 -->
          <li
            v-if="item.separator"
            class="border-t border-zinc-700 px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-zinc-500"
            :class="{ 'mt-1': i > 0 }"
          >
            {{ item.label }}
          </li>
          <!-- 選択可能アイテム -->
          <li
            v-else
            class="flex cursor-pointer items-center justify-between px-3 py-1.5 text-sm"
            :class="
              i === selectedIndex
                ? 'bg-zinc-700 text-zinc-100'
                : 'text-zinc-300 hover:bg-zinc-700/50'
            "
            @click="
              () => {
                selectedIndex = i;
                accept();
              }
            "
            @pointerenter="selectedIndex = i"
          >
            <span>{{ item.label }}</span>
            <span v-if="item.description" class="ml-4 shrink-0 text-xs text-zinc-500">
              {{ item.description }}
            </span>
          </li>
        </template>
      </ul>
      <div v-else class="px-3 py-4 text-center text-sm text-zinc-500">No matching items</div>
    </div>
  </Dialog>
</template>

<style>
._quick-pick-dialog {
  padding: 0;
  border: none;
  background: transparent;
  margin: 15vh auto 0;
}

._quick-pick-dialog::backdrop {
  background: transparent;
}
</style>
