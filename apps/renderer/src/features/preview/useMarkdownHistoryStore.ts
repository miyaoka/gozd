/**
 * Markdown preview 内部リンク遷移の back / forward 履歴を管理する pinia store。
 *
 * スコープ規律: 履歴に積むのは **MarkdownPreview の `<a>` クリック由来の遷移のみ**。
 * filer クリック / terminal リンク / programmatic selection など、それ以外の経路で
 * `worktreeStore.selection` が変化したら履歴は破棄する（ブラウザの「別 origin に飛んだら
 * 履歴コンテキストが切れる」のと同じ感覚）。
 *
 * 内部 nav と外部 nav の判別: `applySelection` の同期スコープ内で `isInternalNav` フラグを
 * 立て、`finally` で必ず reset する。`worktreeStore.selection` を `flush: 'sync'` で watch し、
 * フラグが立っていなければ「外部遷移」とみなして両スタックをクリアする。flag reset を
 * watch の副作用に依存させないことで、`worktreeStore.selectRelPath` の `dir` 未確立 early
 * return 経路など、selection の書き換えが走らない経路でもフラグが居残らないことを保証する。
 *
 * 履歴スタックの上限: **設けない**。md preview の navigate は人間が `<a>` をクリックする
 * 経路でのみ発生するため、現実的な操作頻度で memory pressure になる事象が観測されていない。
 * 必要になったら本ファイル冒頭の不変条件として明示した上で cap を入れる。
 */
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { type PathTarget, pathTargetEquals, type Selection, useWorktreeStore } from "../worktree";

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
    try {
      worktreeStore.selectFromTarget(entry.selection, entry.selection.lineNumber);
    } finally {
      isInternalNav = false;
    }
  }

  /** 現在の selection と target+lineNumber が同値か。`navigate` の冪等化に使う */
  function isSameAsCurrent(target: PathTarget, lineNumber: number | undefined): boolean {
    const sel = worktreeStore.selection;
    if (sel === undefined) return false;
    return pathTargetEquals(sel, target) && sel.lineNumber === lineNumber;
  }

  function navigate(target: PathTarget, lineNumber?: number) {
    // 同パス + 同 lineNumber への再 navigate は履歴に積まずに no-op。
    // これをやらないと自己リンクや「[a.md] ↔ [b.md] 往復」で back スタックが汚染され、
    // back ボタン押下で見た目変化のない遷移が混じる。
    if (isSameAsCurrent(target, lineNumber)) return;

    const current = snapshotCurrent();
    if (current !== undefined) {
      back.value.push(current);
    }
    forward.value = [];
    applySelection({ selection: { ...target, lineNumber } });
  }

  function goBack() {
    const prev = back.value.pop();
    if (prev === undefined) return;
    const current = snapshotCurrent();
    if (current !== undefined) {
      forward.value.push(current);
    }
    applySelection(prev);
  }

  function goForward() {
    const next = forward.value.pop();
    if (next === undefined) return;
    const current = snapshotCurrent();
    if (current !== undefined) {
      back.value.push(current);
    }
    applySelection(next);
  }

  watch(
    () => worktreeStore.selection,
    () => {
      if (isInternalNav) return;
      back.value = [];
      forward.value = [];
    },
    { flush: "sync" },
  );

  return {
    canGoBack,
    canGoForward,
    navigate,
    goBack,
    goForward,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useMarkdownHistoryStore, import.meta.hot));
}
