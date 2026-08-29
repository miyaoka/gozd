import type { GitCommit } from "@gozd/rpc";
import type { ElectronRpcBridge } from "@gozd/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, expect, test } from "vitest";
import { render } from "vitest-browser-vue";
import { useGitGraphStore } from "../../useGitGraphStore";
import CommitGraphList from "./CommitGraphList.vue";
import { GRAPH_PADDING_X, LANE_WIDTH } from "./graphGeometry";

/**
 * グラフ描画の 3 経路 (行をまたぐ SVG overlay / Working Tree 行の SVG / gap 行のラベル) が、
 * date 列の右にある graph 列へ揃うことを実ブラウザで検証する。
 *
 * date 列は `max-content` で、幅は locale の日時表記と実データで決まる。3 経路はいずれも
 * absolute / padding で位置を作るため、この幅を取り違えるとレーンと dot が行の内容から
 * ずれる。ずれ量は date 列の幅そのもので、レイアウトを持たない DOM では 3 経路とも 0 に
 * 揃って見えるため検出できない。
 *
 * 縦位置も同じ理由で見る。overlay は grid の行 line を指定せず `top` で commit 行域まで
 * 下げ、Working Tree 行の SVG はセルが `h-full` で行高を取ることに依存する。どちらも
 * 「横を grid に委ねたのだから縦も」と書き換えられる余地があり、そのとき dot は 1 行ぶん /
 * 半行ぶんずれる。
 *
 * 期待値に px リテラルを置かず「graph 列セルの辺」を基準にするのは、date 列の幅が環境依存で
 * あることと、この検証が見たいのが絶対座標ではなく列との一致だから。
 */
const COMMIT_SEC = Math.floor(Date.UTC(2026, 7, 29, 12, 0, 0) / 1000);

/** 列の一致だけを見るので、subpixel の丸め差は許容する (列幅は数十 px あり退行は埋もれない) */
const PX_PRECISION = 1;

function commit(overrides: Partial<GitCommit> & Pick<GitCommit, "hash">): GitCommit {
  return {
    shortHash: overrides.hash.slice(0, 7),
    parents: [],
    author: "miyaoka",
    date: COMMIT_SEC,
    message: "chore: seed",
    body: "",
    refs: [],
    truncatedAbove: false,
    ...overrides,
  };
}

/** 末尾の commit を別セグメント先頭にして gap 行を 1 行挿入させる */
const COMMITS: GitCommit[] = [
  commit({ hash: "a".repeat(40), refs: ["HEAD", "main"], parents: ["b".repeat(40)] }),
  commit({ hash: "b".repeat(40), parents: ["c".repeat(40)] }),
  commit({ hash: "c".repeat(40), truncatedAbove: true }),
];

/** 描画経路が RPC を叩かないことも同時に固定する (叩けば throw して落ちる) */
function installRpcBridge() {
  const bridge: ElectronRpcBridge = {
    request: (path) => {
      throw new Error(`unexpected RPC: ${path}`);
    },
    onPush: () => {},
  };
  window.__gozdElectronRpc = bridge;
}

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  installRpcBridge();
  pinia = createPinia();
  setActivePinia(pinia);
  useGitGraphStore().commits = COMMITS;
});

/** graph 列の右に message / author / hash が並ぶ実運用相当の幅。狭いと列が潰れて一致が自明になる */
const PANE_WIDTH_PX = 800;

function renderList() {
  const container = document.createElement("div");
  container.style.width = `${PANE_WIDTH_PX}px`;
  container.style.height = "300px";
  document.body.appendChild(container);
  render(CommitGraphList, {
    container,
    props: { prByBranch: new Map() },
    global: { plugins: [pinia] },
  });
  return container;
}

function query(root: ParentNode, selector: string): Element {
  const el = root.querySelector(selector);
  if (el === null) throw new Error(`not rendered: ${selector}`);
  return el;
}

function rows(container: Element): Element[] {
  const found = [...container.querySelectorAll("._graph-row")];
  if (found.length < 2)
    throw new Error(`expected Working Tree row and commit rows, got ${found.length}`);
  return found;
}

/** 行 (`._graph-row`) の graph 列セル。セルは列トラック順に並び、graph は date の次 */
function graphCell(row: Element): Element {
  const cell = row.children[1];
  if (cell === undefined) throw new Error("row does not render a graph cell");
  return cell;
}

/** 行にも gap 行のラベルにも属さない唯一の svg が、行をまたぐ overlay */
function overlaySvg(container: Element): Element {
  const svg = [...container.querySelectorAll("svg")].find(
    (el) => el.closest("._graph-row, ._graph-gap-label") === null,
  );
  if (svg === undefined) throw new Error("overlay svg is not rendered");
  return svg;
}

test("date 列が graph 列の左に幅を持つ", () => {
  const container = renderList();
  const commitRow = rows(container).at(-1)!;

  const dateCell = query(commitRow, ":scope > *");
  expect(dateCell.textContent?.trim()).not.toBe("");
  // 幅 0 だと以降の「graph 列に揃う」assert が行左端との一致でも通ってしまう
  expect(dateCell.getBoundingClientRect().width).toBeGreaterThan(0);
  expect(graphCell(commitRow).getBoundingClientRect().left).toBeGreaterThan(
    commitRow.getBoundingClientRect().left,
  );
});

test("行をまたぐ SVG overlay が graph 列に載る", () => {
  const container = renderList();
  const commitRow = rows(container).at(-1)!;

  expect(overlaySvg(container).getBoundingClientRect().left).toBeCloseTo(
    graphCell(commitRow).getBoundingClientRect().left,
    PX_PRECISION,
  );
});

test("行をまたぐ SVG overlay が commit 行域の先頭から始まる", () => {
  const container = renderList();
  const [workingTreeRow, firstCommitRow] = rows(container);

  // overlay の縦位置は grid の行 line ではなく top で作る。行 line を指定すると
  // containing block の上端が動き、top が二重に効いて dot が 1 行ぶん下がる
  expect(overlaySvg(container).getBoundingClientRect().top).toBeCloseTo(
    firstCommitRow.getBoundingClientRect().top,
    PX_PRECISION,
  );
  expect(firstCommitRow.getBoundingClientRect().top).toBeGreaterThan(
    workingTreeRow.getBoundingClientRect().top,
  );
});

test("Working Tree 行の SVG が graph 列の左上に載る", () => {
  const container = renderList();
  const rowList = rows(container);
  const workingTreeRow = rowList[0];
  const cell = graphCell(workingTreeRow);
  const svg = query(workingTreeRow, "svg");

  expect(svg.getBoundingClientRect().left).toBeCloseTo(
    graphCell(rowList.at(-1)!).getBoundingClientRect().left,
    PX_PRECISION,
  );
  // セルの h-full が外れると、内容高 0 のセルが行の中央に潰れて svg ごと下がる。
  // 期待値は行の content 高 (clientHeight) から取る。行は border-box + border-b で、
  // 行の指定高そのものとは 1px ずれる
  expect(svg.getBoundingClientRect().top).toBeCloseTo(
    workingTreeRow.getBoundingClientRect().top,
    PX_PRECISION,
  );
  expect(cell.getBoundingClientRect().height).toBeCloseTo(
    workingTreeRow.clientHeight,
    PX_PRECISION,
  );
});

test("gap 行のラベルが graph 列基準で字下げされ、行末まで伸びる", () => {
  const container = renderList();
  const commitRow = rows(container).at(-1)!;
  const label = query(container, "._graph-gap-label");

  // padding は border box の内側に効くため、字下げ後の位置は先頭の子 (アイコン) で見る
  const icon = query(label, ":scope > *");
  expect(icon.getBoundingClientRect().left).toBeCloseTo(
    graphCell(commitRow).getBoundingClientRect().left + GRAPH_PADDING_X + LANE_WIDTH,
    PX_PRECISION,
  );
  // graph 列 1 本ぶんに閉じ込められていないこと (文言は overflow で見えてしまい、左端だけでは分からない)
  expect(label.getBoundingClientRect().right).toBeCloseTo(
    commitRow.getBoundingClientRect().right,
    PX_PRECISION,
  );
});
