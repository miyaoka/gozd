/**
 * サーフェスの重ね順・フォーカス追従・閉じる対象の判断を、DOM に触れずに決める純粋モデル。
 *
 * 返すのは「何を hide / show / focus するか」の**操作列**で、DOM へ流すのは `topLayerSurface` の
 * 役目。判断と実行を分けているのは、順序そのものが仕様だから — pin の積み直しをサーフェスの
 * show より前へ動かすとトーストが沈み、閉じた面がフォーカスを持っていたかを見落とすと
 * ターミナルからフォーカスを引き剥がす。どちらも DOM 無しでは再現できない環境
 * (happy-dom / jsdom は `showPopover` を実装していない) に置くと固定できないため、判断だけを
 * こちらへ寄せる。
 *
 * 要素の同一性は参照で見る (`===`)。型引数にしているのは DOM 型への依存を持たないため。
 */

/** DOM へ流す操作。順序に意味がある。 */
export type SurfaceOp<T> =
  | { kind: "show"; el: T }
  | { kind: "hide"; el: T }
  | { kind: "focus"; el: T };

/** 前面順 (末尾が最前面) と、その後に実行する操作列。 */
export interface SurfacePlan<T> {
  stack: T[];
  ops: SurfaceOp<T>[];
}

/** item が最前面か。 */
export function isFront<T>(stack: readonly T[], item: T): boolean {
  return stack.at(-1) === item;
}

/** 最前面。空なら undefined。 */
export function front<T>(stack: readonly T[]): T | undefined {
  return stack.at(-1);
}

/** item を最前面へ移す。既に含まれていれば取り除いてから積み直す (重複を作らない)。 */
function withFront<T>(stack: readonly T[], item: T): T[] {
  return [...stack.filter((s) => s !== item), item];
}

/**
 * pin 済みの積み直し。サーフェスの show の**後**に置く — 前だと pin がサーフェスの下に沈む。
 * 開いていない pin は対象外。
 */
function restackOps<T>(pinnedOpen: readonly T[]): SurfaceOp<T>[] {
  return pinnedOpen.flatMap((el): SurfaceOp<T>[] => [
    { kind: "hide", el },
    { kind: "show", el },
  ]);
}

/** サーフェスを開く。show 順の規則により、開いたものがそのまま最前面になる。 */
export function planShow<T>(
  stack: readonly T[],
  el: T,
  options: { hasFocusInside: boolean; pinnedOpen: readonly T[] },
): SurfacePlan<T> {
  const ops: SurfaceOp<T>[] = [{ kind: "show", el }];
  // 既に内側にフォーカスがあれば奪わない (編集中の入力先を保つ)
  if (!options.hasFocusInside) ops.push({ kind: "focus", el });
  return { stack: withFront(stack, el), ops: [...ops, ...restackOps(options.pinnedOpen)] };
}

/**
 * サーフェスを最前面へ持ち上げる。既に最前面 / 開いていないなら操作なし。
 * top layer の順序は show 呼び出し順が SSOT なので、持ち上げは hide → show でしか表現できない。
 */
export function planRaise<T>(
  stack: readonly T[],
  el: T,
  options: { isOpen: boolean; hasFocusInside: boolean; pinnedOpen: readonly T[] },
): SurfacePlan<T> {
  if (!options.isOpen || isFront(stack, el)) return { stack: [...stack], ops: [] };
  const ops: SurfaceOp<T>[] = [
    { kind: "hide", el },
    { kind: "show", el },
  ];
  if (!options.hasFocusInside) ops.push({ kind: "focus", el });
  return { stack: withFront(stack, el), ops: [...ops, ...restackOps(options.pinnedOpen)] };
}

/** `planHide` の結果。復帰先へのフォーカスは要素が DOM 側にしか無いため別フラグで返す。 */
export interface HidePlan<T> extends SurfacePlan<T> {
  /** 開く前のフォーカス元へ戻すか (列が空になり、かつ閉じた面がフォーカスを持っていた)。 */
  restoreReturnFocus: boolean;
  /** 復帰先の控えを捨てるか (列が空になった。実際に復帰したかどうかとは独立)。 */
  clearReturnFocus: boolean;
}

/**
 * サーフェスを閉じる。フォーカスを移すのは**閉じた面が持っていたときだけ**。
 *
 * close はユーザー操作と無関係な経路 (worktree 切替 / 選択消失) からも来るため、無条件に移すと
 * ターミナルやサイドバーからフォーカスを引き剥がす。
 */
export function planHide<T>(
  stack: readonly T[],
  el: T,
  options: { hadFocus: boolean },
): HidePlan<T> {
  const next = stack.filter((s) => s !== el);
  const ops: SurfaceOp<T>[] = [{ kind: "hide", el }];
  const nextFront = front(next);
  if (options.hadFocus && nextFront !== undefined) ops.push({ kind: "focus", el: nextFront });
  return {
    stack: next,
    ops,
    restoreReturnFocus: options.hadFocus && nextFront === undefined,
    clearReturnFocus: nextFront === undefined,
  };
}
