import { afterEach, expect, test } from "vitest";
import { render } from "vitest-browser-vue";
import { type Ref, defineComponent, h, ref, shallowRef } from "vue";
import { pinSurface, unpinSurface } from "./topLayerSurface";
import { useSurface } from "./useSurface";

/**
 * サーフェスの重ね順とフォーカス追従を、実ブラウザの top layer で検証する。
 *
 * 判断の純粋モデル (`surfaceStack`) は bun 側で守られている。ここで見るのはその判断を DOM へ
 * 流した結果で、シミュレーション環境には存在しない 3 つに依存する: `showPopover()` が作る
 * top layer の実順序 (z-index では越えられない)、重なった座標のヒットテスト、
 * `document.activeElement` の実挙動。
 *
 * 重なりの前後は `elementFromPoint` で決める。DOM 上の並び順や z-index を読んでも、top layer に
 * 載った要素が実際にどちらへ描かれるかは分からない。
 */

/** 2 枚が横に半分ずつ重なる配置。重なり領域のヒットテストで前後を判定する */
const SURFACE_WIDTH_PX = 200;
const SURFACE_HEIGHT_PX = 200;
const OVERLAP_X_PX = 150;
const A_LEFT_PX = 0;
const B_LEFT_PX = 100;
/** A だけが占める領域。B に覆われていないのでクリックが A へ届く */
const A_EXPOSED_X_PX = 50;
/** B だけが占める領域 */
const B_EXPOSED_X_PX = 250;
const MID_Y_PX = 100;

/**
 * pin 対象は重なり領域だけを覆う。A / B それぞれの露出部を pin の外に残しておかないと、
 * 「pin が最前面」の assert がサーフェスの開閉と無関係に通ってしまう
 */
const PIN_LEFT_PX = 100;
const PIN_WIDTH_PX = 100;

/** スクロール位置の保持を見るため、器より十分高い中身を入れる */
const TALL_CONTENT_HEIGHT_PX = 1000;
const SCROLL_OFFSET_PX = 120;

function boxStyle(left: number, width = SURFACE_WIDTH_PX): Record<string, string> {
  return {
    position: "fixed",
    top: "0px",
    left: `${left}px`,
    width: `${width}px`,
    height: `${SURFACE_HEIGHT_PX}px`,
    margin: "0",
    padding: "0",
    border: "none",
    overflow: "auto",
  };
}

/**
 * サーフェス 1 枚。本番と同じ形で root を `popover="manual"` + `tabindex="-1"` にし、
 * 前面化を root の pointerdown キャプチャへ繋ぐ。テストから `raise` を直接呼ぶと、
 * この配線が壊れても気付けない。
 */
function defineSurface(name: string, left: number, isOpen: Ref<boolean>, raiseSignal: Ref<number>) {
  return defineComponent({
    name: `Surface${name}`,
    setup() {
      const el = shallowRef<HTMLElement | null>(null);
      const { raise } = useSurface(el, {
        isOpen: () => isOpen.value,
        requestClose: () => {
          isOpen.value = false;
        },
        raiseSignal: () => raiseSignal.value,
      });
      return () =>
        h(
          "div",
          {
            ref: el,
            popover: "manual",
            tabindex: -1,
            "data-testid": `surface-${name}`,
            style: boxStyle(left),
            onPointerdownCapture: raise,
          },
          [
            h("input", { "data-testid": `input-${name}`, style: { display: "block" } }),
            h("div", { style: { height: `${TALL_CONTENT_HEIGHT_PX}px` } }),
          ],
        );
    },
  });
}

const openA = ref(false);
const openB = ref(false);

/**
 * クリックを介さない前面化要求 (preview の reveal / summary 進入)。単調増加で、
 * 値が変わるたびに raise が走る
 */
const raiseA = ref(0);
const raiseB = ref(0);

/**
 * サーフェス 2 枚、サーフェス外のフォーカス先、pin 対象を 1 つずつ持つ器。
 *
 * pin 対象は `useSurface` を通さない素の popover にする。本番で pin されるのはトーストだけで、
 * それは前面順の列に加わらない非サーフェスだから (`topLayerSurface` の pin セクション)。
 * サーフェスを pin すると、列の控えでは B が最前面なのに DOM では pin が最前面という、
 * 本番では起きない乖離をテストが正常系として固定してしまう。
 */
const Harness = defineComponent({
  setup() {
    const SurfaceA = defineSurface("a", A_LEFT_PX, openA, raiseA);
    const SurfaceB = defineSurface("b", B_LEFT_PX, openB, raiseB);
    return () =>
      h("div", [
        h("button", { "data-testid": "outside" }, "outside"),
        h("div", {
          "data-testid": "toast",
          popover: "manual",
          style: boxStyle(PIN_LEFT_PX, PIN_WIDTH_PX),
        }),
        h(SurfaceA),
        h(SurfaceB),
      ]);
  },
});

/**
 * 座標を占めている検証対象の testid。対象がその座標に無ければ undefined。
 *
 * 器 (`document.body` と render の container) にも testid が振られるため、セレクタは
 * 検証対象だけに絞る。絞らないと「何も無い」を判定したいときに器を拾う。
 */
function topAt(x: number, y: number): string | undefined {
  const hit = document.elementFromPoint(x, y);
  const target = hit?.closest<HTMLElement>('[data-testid^="surface-"], [data-testid="toast"]');
  return target?.dataset.testid;
}

function elByTestId<T extends HTMLElement>(testId: string): T {
  const el = document.querySelector<T>(`[data-testid="${testId}"]`);
  if (el === null) throw new Error(`${testId} is not rendered`);
  return el;
}

const surfaceEl = (name: string) => elByTestId(`surface-${name}`);
const inputEl = (name: string) => elByTestId<HTMLInputElement>(`input-${name}`);

/**
 * A → B の順に開き、B が重なりの手前・A の露出部が A であることを確かめる。
 *
 * 事前状態を固定しないと、以降の「A が手前に来る」assert は B が一度も開かなくても通る。
 */
function openBothWithBInFront(): void {
  openA.value = true;
  openB.value = true;
  expect(topAt(OVERLAP_X_PX, MID_Y_PX)).toBe("surface-b");
  expect(topAt(A_EXPOSED_X_PX, MID_Y_PX)).toBe("surface-a");
}

afterEach(() => {
  // 後始末はコンポーネントが生きているうちに行う。次のテストの beforeEach まで遅らせると
  // 先に unmount され、閉じられなかったサーフェスが前面順の控えに残る
  openA.value = false;
  openB.value = false;
  // pin は module singleton に溜まる。assert が落ちた回でも確実に外す
  const toast = document.querySelector<HTMLElement>('[data-testid="toast"]');
  if (toast !== null) unpinSurface(toast);
});

test("後から開いたサーフェスが重なりの手前に来る", () => {
  render(Harness);

  openBothWithBInFront();
});

test("覆われたサーフェスをクリックすると前面へ来る", async () => {
  const screen = render(Harness);
  openBothWithBInFront();

  // B に覆われていない A の領域を突く。root の pointerdown キャプチャを通る経路
  await screen.getByTestId("surface-a").click({ position: { x: A_EXPOSED_X_PX, y: MID_Y_PX } });

  expect(topAt(OVERLAP_X_PX, MID_Y_PX)).toBe("surface-a");
});

test("pin した要素はサーフェスを開いても最前面に残る", () => {
  render(Harness);
  const toast = elByTestId("toast");
  toast.showPopover();
  pinSurface(toast);

  // サーフェスの show のたびに pin を積み直すので、開いた面が pin を越えない。
  // 各段で pin の外の露出部を見て、面が実際に開いたことを確かめてから重なりを判定する
  openA.value = true;
  expect(topAt(A_EXPOSED_X_PX, MID_Y_PX)).toBe("surface-a");
  expect(topAt(OVERLAP_X_PX, MID_Y_PX)).toBe("toast");

  openB.value = true;
  expect(topAt(B_EXPOSED_X_PX, MID_Y_PX)).toBe("surface-b");
  expect(topAt(OVERLAP_X_PX, MID_Y_PX)).toBe("toast");
});

test("前面化してもサーフェス内の入力先が変わらない", () => {
  render(Harness);
  openBothWithBInFront();
  inputEl("a").focus();

  // クリック経由だと押した root へフォーカスが移るのが自然な挙動なので、
  // 入力先の保持を見るにはクリックを介さない前面化要求を使う (Monaco 編集中の reveal 相当)
  raiseA.value += 1;

  expect(topAt(OVERLAP_X_PX, MID_Y_PX)).toBe("surface-a");
  // 積み直し (hide → show) でフォーカスが落ちても、掴んでいた要素へ戻す契約
  expect(document.activeElement).toBe(inputEl("a"));
});

test("前面化してもスクロール位置が保たれる", () => {
  render(Harness);
  openBothWithBInFront();
  const a = surfaceEl("a");
  a.scrollTop = SCROLL_OFFSET_PX;

  raiseA.value += 1;

  // 前面化は hide → show の積み直しでしか表現できない。積み直しを経ても
  // 中身の読み位置が巻き戻らないことを見る
  expect(topAt(OVERLAP_X_PX, MID_Y_PX)).toBe("surface-a");
  expect(a.scrollTop).toBe(SCROLL_OFFSET_PX);
});

test("フォーカスを持つサーフェスを閉じると次の前面へフォーカスが移る", () => {
  render(Harness);
  openBothWithBInFront();
  inputEl("b").focus();

  openB.value = false;

  expect(document.activeElement).toBe(surfaceEl("a"));
});

test("フォーカスを持たないサーフェスを閉じてもフォーカスは動かない", () => {
  render(Harness);
  openBothWithBInFront();
  const outside = elByTestId("outside");
  outside.focus();

  openB.value = false;

  // close は worktree 切替のようなユーザー操作と無関係な経路からも来る。
  // 無条件にフォーカスを移すとターミナルから入力先を引き剥がす
  expect(document.activeElement).toBe(outside);
});

test("最後の 1 枚を閉じると開く前のフォーカス元へ戻る", () => {
  render(Harness);
  const outside = elByTestId("outside");
  outside.focus();

  // 1 枚も開いていない状態から開くときだけ、開く前のフォーカス元を控える
  openA.value = true;
  surfaceEl("a").focus();

  openA.value = false;

  // ターミナルのリンクから preview を開いて閉じると、入力がターミナルへ戻る経路
  expect(document.activeElement).toBe(outside);
});
