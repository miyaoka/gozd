import { beforeEach, expect, test } from "vitest";
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
const MID_Y_PX = 100;

/** スクロール位置の保持を見るため、器より十分高い中身を入れる */
const TALL_CONTENT_HEIGHT_PX = 1000;
const SCROLL_OFFSET_PX = 120;

function surfaceStyle(left: number): Record<string, string> {
  return {
    position: "fixed",
    top: "0px",
    left: `${left}px`,
    width: `${SURFACE_WIDTH_PX}px`,
    height: `${SURFACE_HEIGHT_PX}px`,
    margin: "0",
    padding: "0",
    border: "none",
    overflow: "auto",
  };
}

/**
 * サーフェス 1 枚。実際の配線と同じく root を `popover="manual"` + `tabindex="-1"` にし、
 * 前面化は `pointerdown` のキャプチャに繋ぐ (テストから raise を直接呼ぶと、クリック経路が
 * 壊れても気付けない)。
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
            style: surfaceStyle(left),
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

/** 2 枚のサーフェスと、サーフェス外のフォーカス先を 1 つ持つ器 */
const Harness = defineComponent({
  setup() {
    const SurfaceA = defineSurface("a", A_LEFT_PX, openA, raiseA);
    const SurfaceB = defineSurface("b", B_LEFT_PX, openB, raiseB);
    return () =>
      h("div", [h("button", { "data-testid": "outside" }, "outside"), h(SurfaceA), h(SurfaceB)]);
  },
});

/** 座標を占めているサーフェスの名前。何も無ければ undefined */
function surfaceAt(x: number, y: number): string | undefined {
  const hit = document.elementFromPoint(x, y);
  const surface = hit?.closest<HTMLElement>('[data-testid^="surface-"]');
  return surface?.dataset.testid?.replace("surface-", "");
}

function elByTestId<T extends HTMLElement>(testId: string): T {
  const el = document.querySelector<T>(`[data-testid="${testId}"]`);
  if (el === null) throw new Error(`${testId} is not rendered`);
  return el;
}

const surfaceEl = (name: string) => elByTestId(`surface-${name}`);
const inputEl = (name: string) => elByTestId<HTMLInputElement>(`input-${name}`);

beforeEach(() => {
  openA.value = false;
  openB.value = false;
});

test("後から開いたサーフェスが重なりの手前に来る", async () => {
  render(Harness);

  openA.value = true;
  openB.value = true;

  expect(surfaceAt(OVERLAP_X_PX, MID_Y_PX)).toBe("b");
});

test("覆われたサーフェスをクリックすると前面へ来る", async () => {
  const screen = render(Harness);
  openA.value = true;
  openB.value = true;

  // B に覆われていない A の領域を突く。実配線の pointerdown capture を通す経路
  await screen.getByTestId("surface-a").click({ position: { x: A_EXPOSED_X_PX, y: MID_Y_PX } });

  expect(surfaceAt(OVERLAP_X_PX, MID_Y_PX)).toBe("a");
});

test("pin したサーフェスは後から開いたサーフェスより手前に残る", async () => {
  render(Harness);
  openA.value = true;
  const pinned = surfaceEl("a");
  pinSurface(pinned);

  // pin 済みが開いている状態で別のサーフェスを開くと、show の後に pin が積み直される
  openB.value = true;

  expect(surfaceAt(OVERLAP_X_PX, MID_Y_PX)).toBe("a");
  unpinSurface(pinned);
});

test("前面化してもサーフェス内の入力先が変わらない", async () => {
  render(Harness);
  openA.value = true;
  openB.value = true;
  inputEl("a").focus();

  // クリック経由だと押した root へフォーカスが移るのが自然な挙動なので、
  // 入力先の保持を見るにはクリックを介さない前面化要求を使う (Monaco 編集中の reveal 相当)
  raiseA.value += 1;

  expect(surfaceAt(OVERLAP_X_PX, MID_Y_PX)).toBe("a");
  // 積み直し (hide → show) でフォーカスが落ちても、掴んでいた要素へ戻す契約
  expect(document.activeElement).toBe(inputEl("a"));
});

test("前面化してもスクロール位置が保たれる", async () => {
  render(Harness);
  openA.value = true;
  openB.value = true;
  const a = surfaceEl("a");
  a.scrollTop = SCROLL_OFFSET_PX;

  raiseA.value += 1;

  // 前面化は hide → show の積み直しでしか表現できない。積み直しが起きたうえで
  // 中身の読み位置が巻き戻らないことを見る (前面化の assert が無いと、raise が
  // まるごと no-op に退行しても素通りする)
  expect(surfaceAt(OVERLAP_X_PX, MID_Y_PX)).toBe("a");
  expect(a.scrollTop).toBe(SCROLL_OFFSET_PX);
});

test("フォーカスを持つサーフェスを閉じると次の前面へフォーカスが移る", async () => {
  render(Harness);
  openA.value = true;
  openB.value = true;
  inputEl("b").focus();

  openB.value = false;

  expect(document.activeElement).toBe(surfaceEl("a"));
});

test("フォーカスを持たないサーフェスを閉じてもフォーカスは動かない", async () => {
  render(Harness);
  openA.value = true;
  openB.value = true;
  const outside = elByTestId("outside");
  outside.focus();

  openB.value = false;

  // close は worktree 切替のようなユーザー操作と無関係な経路からも来る。
  // 無条件にフォーカスを移すとターミナルから入力先を引き剥がす
  expect(document.activeElement).toBe(outside);
});
