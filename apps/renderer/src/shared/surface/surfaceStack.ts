/**
 * サーフェスの重ね順・フォーカス追従・閉じる対象の判断を、DOM に触れずに決める純粋モデル。
 *
 * 返すのは「何を hide / show / focus するか」の**操作列**で、DOM へ流すのは `topLayerSurface` の
 * 役目。判断と実行を分けているのは、順序そのものが仕様だから — pin の積み直しをサーフェスの
 * show より前へ動かすとトーストが沈み、閉じた面がフォーカスを持っていたかを見落とすと
 * ターミナルからフォーカスを引き剥がす。
 *
 * 操作列を値として返せば、この順序を入力の組み合わせごとにそのまま assert できる。DOM へ流した
 * 後に観測できるのは結果 (今どれが前面か、フォーカスがどこにあるか) だけで、そこへ至った操作列は
 * 復元できない — 余計な積み直しも、省いた focus op も、たまたま同じ結果へ着地すれば通ってしまう。
 * 実ブラウザでしか判定できないものは `topLayerSurface.browser-test.ts` が受け持つ。
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
function isFront<T>(stack: readonly T[], item: T): boolean {
  return stack.at(-1) === item;
}

/** 最前面。空なら undefined。 */
function front<T>(stack: readonly T[]): T | undefined {
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

/**
 * サーフェスを開く。show 順の規則により、開いたものがそのまま最前面になる。
 *
 * 閉じている popover は `display: none` で内側にフォーカスを持てないため、行き先は常に root。
 */
export function planShow<T>(
  stack: readonly T[],
  el: T,
  options: { pinnedOpen: readonly T[] },
): SurfacePlan<T> {
  return {
    stack: withFront(stack, el),
    ops: [{ kind: "show", el }, { kind: "focus", el }, ...restackOps(options.pinnedOpen)],
  };
}

/**
 * サーフェスを最前面へ持ち上げる。既に最前面 / 開いていないなら操作なし。
 * top layer の順序は show 呼び出し順が SSOT なので、持ち上げは hide → show でしか表現できない。
 *
 * focus は **show の後**に置く。hide と show の間のサーフェスは `display: none` で focusable では
 * なく、この区間へ出した focus op は例外も出さずに何も起こさない。順序を入れ替えると、フォーカスが
 * 前面に追従しないまま積み直しだけが終わる (`planShow` が行き先を常に root にするのと同じ制約)。
 *
 * 行き先は「積み直し前に内側でフォーカスを持っていた要素」で、無ければ root。`hidePopover()` の
 * 後にフォーカスが中へ残るかはブラウザの遅延挙動に依存するため、残る前提で focus op を省くと、
 * 残らなかった瞬間にフォーカスが body へ落ちて ESC / Cmd+W が無反応になる。常に出しておけば
 * 残っていた場合は同一要素への no-op、落ちていた場合は元の入力先への復元になる。
 */
export function planRaise<T>(
  stack: readonly T[],
  el: T,
  options: { isOpen: boolean; focusedInside: T | undefined; pinnedOpen: readonly T[] },
): SurfacePlan<T> {
  if (!options.isOpen || isFront(stack, el)) return { stack: [...stack], ops: [] };
  return {
    stack: withFront(stack, el),
    ops: [
      { kind: "hide", el },
      { kind: "show", el },
      { kind: "focus", el: options.focusedInside ?? el },
      ...restackOps(options.pinnedOpen),
    ],
  };
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
  // 復帰先の控えを動かすのは、このサーフェスが列から抜けた結果として列が空になったときだけ。
  // 列に居なかったサーフェスも close を通る (unmount は DOM の状態を問わず呼ぶため、一度も
  // 開かれなかった面もここへ来る)。それを「列が空になった」と数えると控えを巻き添えで捨てる
  const emptied = stack.includes(el) && nextFront === undefined;
  return {
    stack: next,
    ops,
    restoreReturnFocus: options.hadFocus && emptied,
    clearReturnFocus: emptied,
  };
}
