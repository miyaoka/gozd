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
  /**
   * 端で反対側へ回り込むか。既定は true。
   *
   * **継ぎ足しで伸びる一覧では false にする。**下端がまだ終端ではないため、回り込むと
   * 「続きを見に行く」操作が先頭への移動になる。
   */
  wrap?: boolean;
}

interface UseListNavigationReturn {
  selectedIndex: Ref<number>;
  /** ArrowUp/Down: 移動（`wrap` が false なら端でクランプ） */
  move: (direction: 1 | -1) => void;
  /** PageUp/Down: ページ単位移動（端でクランプ、循環しない） */
  movePage: (direction: 1 | -1) => void;
  /** 選択位置をリセット。index 省略時は先頭の選択可能アイテムに戻す */
  reset: (index?: number) => void;
  /** 現在の選択アイテムまでスクロールする。ダイアログ初期表示後の nextTick 内で呼ぶ */
  scrollToSelected: () => void;
}

/**
 * 1 つ移動した後の位置を返す純関数。`currentPos` が -1（選択が候補から外れた）なら先頭へ戻す。
 *
 * `wrap` が false のときは端でクランプする。継ぎ足しで伸びる一覧では下端が終端ではないため、
 * 回り込むと「続きを見に行く」操作が先頭への移動になる。
 */
export function nextPosition(
  currentPos: number,
  direction: 1 | -1,
  length: number,
  wrap: boolean,
): number {
  if (currentPos === -1) return 0;
  const raw = currentPos + direction;
  if (wrap) return (raw + length) % length;
  return Math.min(Math.max(raw, 0), length - 1);
}

/**
 * リストのキーボードナビゲーションとスクロール追従を提供する composable。
 * CommandPalette / QuickPick / PrPickerDialog で共通利用する。
 */
export function useListNavigation(options: UseListNavigationOptions): UseListNavigationReturn {
  const { listRef, itemCount, selectableIndices, wrap = true } = options;
  const selectedIndex = ref(0);

  /** 選択可能インデックスの配列を取得。selectableIndices 未指定時は全インデックス */
  function getIndices(): number[] {
    if (selectableIndices !== undefined) return selectableIndices.value;
    return Array.from({ length: itemCount.value }, (_, i) => i);
  }

  function move(direction: 1 | -1) {
    const indices = getIndices();
    if (indices.length === 0) return;
    const nextPos = nextPosition(
      indices.indexOf(selectedIndex.value),
      direction,
      indices.length,
      wrap,
    );
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

  /** リスト表示領域に収まる行数を算出する。selectable な行の高さを基準にする */
  function getPageSize(): number {
    const list = listRef.value;
    if (list === null) return 1;
    const baseIndex = selectableIndices !== undefined ? (selectableIndices.value[0] ?? 0) : 0;
    const row = list.children[baseIndex] as HTMLElement | undefined;
    if (row === undefined) return 1;
    return Math.max(1, Math.floor(list.clientHeight / row.offsetHeight));
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

  /** 現在の選択アイテムまでスクロールする */
  function scrollToSelected() {
    const list = listRef.value;
    if (list === null) return;
    const item = list.children[selectedIndex.value] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest", container: "nearest" });
  }

  /** 選択アイテムが画面外に出たらスクロール追従する（DOM 更新後に実行） */
  watch(
    selectedIndex,
    () => {
      scrollToSelected();
    },
    { flush: "post" },
  );

  /**
   * 一覧が変わって選択位置が選択可能でなくなったら先頭へ戻す。
   *
   * 選択できない位置を指したままだと Enter が黙って効かない（選択 item が undefined になる）。
   * 矢印キーを押せば自己修復するので、症状は「たまに Enter が反応しない」という診断しにくい
   * 形で出る。
   *
   * **範囲チェックでは足りない。**separator を挟む一覧では、範囲内のまま選択できない行を指す
   * 状態が作れる。選択可能な index の集合そのものを見る。
   *
   * 末尾へ丸めずに先頭へ戻すのは、一覧が変わった = 別の結果集合になったとみなすため。
   *
   * **空集合でも戻す。**`reset()` は空なら 0 を返し、これは「まだ何も選んでいない」を表す正当な
   * 位置。取得のたびに一覧を空にしてから埋める利用側（検索）は、この 0 経由で次の結果の先頭へ
   * スナップする。空を素通りさせると、前の結果で選んでいた index が次の結果でも選択可能だった
   * 場合に、無関係な行を選んだまま残る。
   */
  watch([itemCount, () => selectableIndices?.value], () => {
    if (getIndices().includes(selectedIndex.value)) return;
    reset();
  });

  return { selectedIndex, move, movePage, reset, scrollToSelected };
}
