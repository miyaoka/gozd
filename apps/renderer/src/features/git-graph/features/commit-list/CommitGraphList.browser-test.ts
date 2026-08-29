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
 * absolute / padding で横位置を作るため、この幅を取り違えるとレーンと dot が行の内容から
 * ずれる。ずれ量は date 列の幅そのものなので、レイアウトを持たない DOM では検出できない。
 *
 * 期待値に px リテラルを置かず「graph 列セルの左端」を基準にするのは、date 列の幅が環境依存で
 * あることと、この検証が見たいのが絶対座標ではなく列との一致だから。
 */
const NOW_SEC = Math.floor(Date.UTC(2026, 7, 29, 12, 0, 0) / 1000);

function commit(overrides: Partial<GitCommit> & Pick<GitCommit, "hash">): GitCommit {
  return {
    shortHash: overrides.hash.slice(0, 7),
    parents: [],
    author: "miyaoka",
    date: NOW_SEC,
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

/** graph 列の右にメッセージ / author / hash が並ぶ実運用相当の幅。狭いと列が潰れて一致が自明になる */
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

/** 行 (`._graph-row`) の graph 列セル。cell 順は列トラック順と同じで、graph は date の次 */
function graphCellLeft(row: Element): number {
  return row.children[1].getBoundingClientRect().left;
}

test("date 列が graph 列の左に幅を持つ", () => {
  const container = renderList();
  const rows = container.querySelectorAll("._graph-row");
  const commitRow = rows[rows.length - 1];

  const dateCell = commitRow.children[0];
  expect(dateCell.textContent?.trim()).not.toBe("");
  // 幅 0 だと以降の「graph 列に揃う」assert が行左端との一致でも通ってしまう
  expect(dateCell.getBoundingClientRect().width).toBeGreaterThan(0);
  expect(graphCellLeft(commitRow)).toBeGreaterThan(commitRow.getBoundingClientRect().left);
});

test("行をまたぐ SVG overlay が graph 列に載る", () => {
  const container = renderList();
  const commitRow = [...container.querySelectorAll("._graph-row")].at(-1)!;

  // overlay は行にも gap 行のラベルにも属さない唯一の svg
  const overlay = [...container.querySelectorAll("svg")].find(
    (svg) => svg.closest("._graph-row, ._graph-gap-label") === null,
  )!;

  expect(overlay.getBoundingClientRect().left).toBe(graphCellLeft(commitRow));
});

test("Working Tree 行の SVG が graph 列に載る", () => {
  const container = renderList();
  const rows = container.querySelectorAll("._graph-row");
  const workingTreeRow = rows[0];
  const commitRow = rows[rows.length - 1];

  const svg = workingTreeRow.querySelector("svg")!;

  expect(svg.getBoundingClientRect().left).toBe(graphCellLeft(commitRow));
});

test("gap 行のラベルが graph 列基準で字下げされる", () => {
  const container = renderList();
  const commitRow = [...container.querySelectorAll("._graph-row")].at(-1)!;

  // padding は border box の内側に効くため、字下げ後の位置は先頭の子 (アイコン) で見る
  const gapIcon = container.querySelector("._graph-gap-label > *")!;

  expect(gapIcon.getBoundingClientRect().left).toBe(
    graphCellLeft(commitRow) + GRAPH_PADDING_X + LANE_WIDTH,
  );
});
