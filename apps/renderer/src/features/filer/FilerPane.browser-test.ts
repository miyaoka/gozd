import type { ElectronRpcBridge } from "@gozd/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, expect, test } from "vitest";
import { render } from "vitest-browser-vue";
import { useRepoStore } from "../../shared/repo";
import FilerPane from "./FilerPane.vue";

/**
 * ファイラーのツリーを worktree 直下から描き、行のどのピクセルで開閉が起きるかを
 * 実ブラウザの当たり判定で検証する。
 *
 * 単体の行ではなく FilerPane から描くのは、症状が「ルート直下の行の左端が効かない」という
 * 位置由来のものだから。不可視ルート配下という実際の入れ子と、scroll コンテナの padding を
 * 含めた状態でないと、左端の座標が実物と一致しない。
 */
const DIR = "/gozd-browser-test/worktree";

const CHILD_NAME = "main.ts";

/** worktree 直下 (`.`) と `src` だけを持つツリー。想定外の path は黙って空にせず落とす */
const TREE: Record<string, { name: string; type: string; isIgnored: boolean }[]> = {
  ".": [
    { name: "src", type: "directory", isIgnored: false },
    { name: "README.md", type: "file", isIgnored: false },
  ],
  src: [{ name: CHILD_NAME, type: "file", isIgnored: false }],
};

/** readDir だけに応答する RPC bridge。ツリー描画に要る経路はこれ 1 本 */
function installRpcBridge() {
  const bridge: ElectronRpcBridge = {
    request: (path, body) => {
      if (path !== "/fs/readDir") throw new Error(`unexpected RPC: ${path}`);
      const { path: relPath } = body as { path: string };
      const entries = TREE[relPath];
      if (entries === undefined) throw new Error(`unexpected readDir path: ${relPath}`);
      return Promise.resolve({ entries, notFound: false });
    },
    onPush: () => {},
  };
  window.__gozdElectronRpc = bridge;
}

/** 描画に渡す pinia。seed (selectDir) と描画で同じ instance を使う */
let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  installRpcBridge();
  pinia = createPinia();
  setActivePinia(pinia);
  useRepoStore().selectDir(DIR);
});

/**
 * 実運用のパネル幅で描く。押下時の縮小量は幅に比例するため、狭い器では縁の移動量が小さく、
 * 当たり判定が壊れていても症状が出ない。
 */
const PANE_WIDTH_PX = 630;

function renderPane() {
  const container = document.createElement("div");
  container.style.width = `${PANE_WIDTH_PX}px`;
  container.style.height = "300px";
  document.body.appendChild(container);
  return render(FilerPane, { container, global: { plugins: [pinia] } });
}

/** 行内の要素の中心を、行 (button) の左上を原点とする click position に変換する */
function centerWithinRow(row: Element, target: Element) {
  const rowRect = row.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  return {
    x: targetRect.left + targetRect.width / 2 - rowRect.left,
    y: targetRect.top + targetRect.height / 2 - rowRect.top,
  };
}

// 症状が「chevron では効かず、アイコン以降で効く」という左右差で出たため、左端の chevron と
// その右隣のフォルダアイコンの両方を通す。現在の縮小量では chevron の中心は縁の移動量より
// 内側にあるので、この 2 点が検出するのは縮小量を上げる方向の退行
const HIT_POINTS = ["svg", "img"] as const;

/** 行の左端 1px。当たり判定の据え置きが外れると、ここが真っ先に効かなくなる */
const LEADING_EDGE_OFFSET_PX = 1;

test("ルート直下のディレクトリ行が左端のクリックで展開する", async () => {
  const screen = renderPane();
  const rowLocator = screen.getByRole("button", { name: "src" });
  await expect.element(rowLocator).toBeVisible();

  const y = rowLocator.element().getBoundingClientRect().height / 2;
  await rowLocator.click({ position: { x: LEADING_EDGE_OFFSET_PX, y } });

  await expect.element(screen.getByRole("button", { name: CHILD_NAME })).toBeVisible();
});

test.each(HIT_POINTS)("ルート直下のディレクトリ行が %s のクリックで展開する", async (selector) => {
  const screen = renderPane();
  const rowLocator = screen.getByRole("button", { name: "src" });
  await expect.element(rowLocator).toBeVisible();

  const row = rowLocator.element();
  const target = row.querySelector(selector);
  if (target === null) throw new Error(`row does not render ${selector}`);

  await rowLocator.click({ position: centerWithinRow(row, target) });

  await expect.element(screen.getByRole("button", { name: CHILD_NAME })).toBeVisible();
});
