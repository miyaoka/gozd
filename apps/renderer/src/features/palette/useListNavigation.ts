import { type ComputedRef, type Ref, ref, watch } from "vue";

/** CSS Overflow 5 の container プロパティ（WKWebView で有効、TypeScript 型定義が未対応） */
declare global {
  interface ScrollIntoViewOptions {
    container?: ScrollLogicalPosition;
  }
}

interface UseListNavigationOptions {
  /** スクロール追従対象のリストコンテナ要素 */
  listRef: Ref<HTMLElement | null>;
  /** リスト内の全アイテム数 */
  itemCount: ComputedRef<number>;
  /**
   * 選択可能なアイテムのインデックス一覧。
   * セパレータ等の選択不可アイテムをスキップする場合に指定する。
   * 省略時は全インデックスが選択可能として扱う。
   */
  selectableIndices?: ComputedRef<number[]>;
}

interface UseListNavigationReturn {
  selectedIndex: Ref<number>;
  /** ArrowUp/Down: 循環移動 */
  move: (direction: 1 | -1) => void;
  /** PageUp/Down: ページ単位移動（端でクランプ、循環しない） */
  movePage: (direction: 1 | -1) => void;
  /** 選択位置をリセット。index 省略時は先頭の選択可能アイテムに戻す */
  reset: (index?: number) => void;
}

/**
 * リストのキーボードナビゲーションとスクロール追従を提供する composable。
 * CommandPalette / QuickPick / PrPickerDialog で共通利用する。
 */
export function useListNavigation(options: UseListNavigationOptions): UseListNavigationReturn {
  const { listRef, itemCount, selectableIndices } = options;
  const selectedIndex = ref(0);

  /** 選択可能インデックスの配列を取得。selectableIndices 未指定時は全インデックス */
  function getIndices(): number[] {
    if (selectableIndices !== undefined) return selectableIndices.value;
    return Array.from({ length: itemCount.value }, (_, i) => i);
  }

  function move(direction: 1 | -1) {
    const indices = getIndices();
    if (indices.length === 0) return;
    const currentPos = indices.indexOf(selectedIndex.value);
    const nextPos =
      currentPos === -1 ? 0 : (currentPos + direction + indices.length) % indices.length;
    selectedIndex.value = indices[nextPos];
  }

  function movePage(direction: 1 | -1) {
    const indices = getIndices();
    if (indices.length === 0) return;
    const pageSize = getPageSize();
    const currentPos = indices.indexOf(selectedIndex.value);
    const pos = currentPos === -1 ? 0 : currentPos;
    const nextPos = Math.max(0, Math.min(pos + direction * pageSize, indices.length - 1));
    selectedIndex.value = indices[nextPos];
  }

  /** リスト表示領域に収まる行数を算出する */
  function getPageSize(): number {
    const list = listRef.value;
    if (list === null) return 1;
    const firstRow = list.children[0] as HTMLElement | undefined;
    if (firstRow === undefined) return 1;
    return Math.max(1, Math.floor(list.clientHeight / firstRow.offsetHeight));
  }

  function reset(index?: number) {
    if (index !== undefined) {
      selectedIndex.value = index;
      return;
    }
    const indices = getIndices();
    const [first] = indices;
    selectedIndex.value = first ?? 0;
  }

  /** 選択アイテムが画面外に出たらスクロール追従する */
  watch(selectedIndex, (idx) => {
    const list = listRef.value;
    if (list === null) return;
    const item = list.children[idx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest", container: "nearest" });
  });

  return { selectedIndex, move, movePage, reset };
}
