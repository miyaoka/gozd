import { afterEach, expect, test } from "vitest";
import { keepInPlace } from "./keepInPlace";

const ROW_HEIGHT = 30;
const INSERT_COUNT = 3;
const LEAF_HEIGHT = 400;
const SCROLLER_MAX_HEIGHT = 200;
// origin から離す量。目印の下にある行 (1 行) の高さ以下にし、目印を可視域に残す
const SCROLL_AWAY = ROW_HEIGHT;

type Edge = "top" | "bottom";
type Side = "below" | "above";

function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function row(): HTMLElement {
  const el = document.createElement("div");
  el.style.height = `${ROW_HEIGHT}px`;
  return el;
}

const mounted: HTMLElement[] = [];

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

// TerminalSessionPreview の overlay と同じ構造: leaf の上端 (main) / 下端 (sub) に固定した
// absolute な overlay の中に、auto 高 + max-height の column-reverse スクロール面と単一の縦並び列。
// 目印 (開閉トグル) は末尾から 2 行目に置く
async function setup(edge: Edge, rowCount: number, scrollAway: boolean) {
  const leaf = document.createElement("div");
  leaf.style.cssText = `position:relative;height:${LEAF_HEIGHT}px;width:300px`;
  const overlay = document.createElement("div");
  overlay.style.cssText = `position:absolute;${edge}:0;right:0;width:200px`;
  const scroller = document.createElement("div");
  scroller.style.cssText = `max-height:${SCROLLER_MAX_HEIGHT}px;overflow-y:auto;display:flex;flex-direction:column-reverse`;
  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column";
  scroller.appendChild(list);
  overlay.appendChild(scroller);
  leaf.appendChild(overlay);
  document.body.appendChild(leaf);
  mounted.push(leaf);
  const rows = Array.from({ length: rowCount }, () => list.appendChild(row()));
  const target = rows[rowCount - 2];
  if (target === undefined) throw new Error("rows not created");
  await frame();
  if (scrollAway) {
    scroller.scrollTop = -SCROLL_AWAY;
    await frame();
  }
  return { scroller, list, target };
}

// 目印の直下 / 直上に行を差し込む (開閉トグルで run を開いたときの DOM 変更)
function insert(list: HTMLElement, target: HTMLElement, side: Side): HTMLElement[] {
  const ref = side === "below" ? target.nextElementSibling : target;
  return Array.from({ length: INSERT_COUNT }, () => list.insertBefore(row(), ref));
}

function topOf(el: HTMLElement): number {
  return el.getBoundingClientRect().top;
}

/**
 * keepInPlace がブラウザの scroll anchoring に任せない根拠と、差し込む位置を overlay の固定端で
 * 選ぶ根拠を固定する。ここが落ちたらブラウザ側の挙動が変わった合図で、keepInPlace と
 * TerminalSessionPreview の差し込む位置の決め方を見直す。
 */
test("スクロール位置が origin にあるとき、直下への挿入で目印が挿入した高さの分だけ上へ動く", async () => {
  const { list, target } = await setup("top", 20, false);
  const before = topOf(target);
  insert(list, target, "below");
  await frame();
  expect(topOf(target)).toBe(before - ROW_HEIGHT * INSERT_COUNT);
});

test("下端固定の overlay では、溢れていないとき直下への挿入で目印が上へ動き、スクロールでは戻せない", async () => {
  const { scroller, list, target } = await setup("bottom", 3, false);
  const before = topOf(target);
  insert(list, target, "below");
  await frame();
  expect(topOf(target)).toBe(before - ROW_HEIGHT * INSERT_COUNT);
  expect(scroller.scrollHeight).toBe(scroller.clientHeight);
});

// overlay が伸びる側 (固定されていない端の側) に差し込む組み合わせ
const PLACEMENTS: { name: string; edge: Edge; side: Side }[] = [
  { name: "上端固定で直下に差し込む", edge: "top", side: "below" },
  { name: "下端固定で直上に差し込む", edge: "bottom", side: "above" },
];

const STATES: { name: string; rowCount: number; scrollAway: boolean }[] = [
  { name: "溢れていない", rowCount: 3, scrollAway: false },
  { name: "差し込むと溢れる", rowCount: 5, scrollAway: false },
  { name: "溢れて origin にいる", rowCount: 20, scrollAway: false },
  { name: "溢れて origin から離れている", rowCount: 20, scrollAway: true },
];

for (const placement of PLACEMENTS) {
  for (const state of STATES) {
    test(`${placement.name} (${state.name}): 差し込んでも取り除いても目印の位置が変わらず、取り除くとスクロール位置も戻る`, async () => {
      const { scroller, list, target } = await setup(
        placement.edge,
        state.rowCount,
        state.scrollAway,
      );
      const before = topOf(target);
      const scrollBefore = scroller.scrollTop;

      const inserted: HTMLElement[] = [];
      await keepInPlace(target, scroller, async () => {
        inserted.push(...insert(list, target, placement.side));
      });
      expect(topOf(target)).toBe(before);
      await frame();
      await frame();
      expect(topOf(target)).toBe(before);

      // 取り除くとスクロール位置も差し込む前に戻る (origin にいたなら origin に戻り、追記に追従する)
      await keepInPlace(target, scroller, async () => {
        for (const el of inserted) el.remove();
      });
      expect(topOf(target)).toBe(before);
      await frame();
      expect(topOf(target)).toBe(before);
      expect(scroller.scrollTop).toBe(scrollBefore);
    });
  }
}
