/**
 * Markdown preview 内部リンク遷移の back / forward 履歴を管理する pinia store。
 *
 * スコープ規律: 履歴に積むのは **MarkdownPreview の `<a>` クリック由来の遷移のみ**。
 * filer クリック / terminal リンク / programmatic selection など、それ以外の経路で
 * `worktreeStore.selection` が変化したら履歴は破棄する（ブラウザの「別 origin に飛んだら
 * 履歴コンテキストが切れる」のと同じ感覚）。
 *
 * 内部 nav と外部 nav の判別: `isInternalNav` フラグを navigate / goBack / goForward の
 * 直前に立て、`selection` を sync watch して fire 時にフラグを読み reset する。flush: 'sync'
 * により selection 書き換えと同 tick で callback が走るため、フラグの寿命は厳密に「1 回の
 * worktreeStore.selectFromTarget 呼び出し分」になる。
 */
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { type PathTarget, type Selection, useWorktreeStore } from "../worktree";

interface HistoryEntry {
  selection: Selection;
}

export const useMarkdownHistoryStore = defineStore("markdown-history", () => {
  const worktreeStore = useWorktreeStore();

  const back = ref<HistoryEntry[]>([]);
  const forward = ref<HistoryEntry[]>([]);

  const canGoBack = computed(() => back.value.length > 0);
  const canGoForward = computed(() => forward.value.length > 0);

  let isInternalNav = false;

  function snapshotCurrent(): HistoryEntry | undefined {
    const sel = worktreeStore.selection;
    if (sel === undefined) return undefined;
    return { selection: { ...sel } };
  }

  function applySelection(entry: HistoryEntry) {
    isInternalNav = true;
    worktreeStore.selectFromTarget(entry.selection, entry.selection.lineNumber);
  }

  function navigate(target: PathTarget, lineNumber?: number) {
    const current = snapshotCurrent();
    if (current !== undefined) {
      back.value.push(current);
    }
    forward.value = [];
    applySelection({ selection: { ...target, lineNumber } });
  }

  function goBack(): boolean {
    const prev = back.value.pop();
    if (prev === undefined) return false;
    const current = snapshotCurrent();
    if (current !== undefined) {
      forward.value.push(current);
    }
    applySelection(prev);
    return true;
  }

  function goForward(): boolean {
    const next = forward.value.pop();
    if (next === undefined) return false;
    const current = snapshotCurrent();
    if (current !== undefined) {
      back.value.push(current);
    }
    applySelection(next);
    return true;
  }

  function clear() {
    back.value = [];
    forward.value = [];
  }

  watch(
    () => worktreeStore.selection,
    () => {
      if (isInternalNav) {
        isInternalNav = false;
        return;
      }
      clear();
    },
    { flush: "sync" },
  );

  return {
    canGoBack,
    canGoForward,
    navigate,
    goBack,
    goForward,
    clear,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useMarkdownHistoryStore, import.meta.hot));
}
