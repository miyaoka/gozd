import type { ElectronRpcBridge } from "@gozd/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-vue";
import { useTerminalStore } from "./useTerminalStore";
import XtermTerminal from "./XtermTerminal.vue";

/**
 * 表示されていない端末が PTY に申告する寸法を、実コンポーネントを通して確かめる。
 *
 * 素の自動調整に任せると実寸とかけ離れた寸法になる（hiddenTerminalFit.browser-test.ts）。
 * ここで見るのは、その値が PTY 起動要求に載らないこと。載ると、起動直後のプログラムが
 * その幅で改行を確定させ、可視化して広げても戻らない。
 */
type SpawnRequest = { cols: number; rows: number };

/** 端末実装の既定寸法。実測が効いていないことを検出するための基準 */
const TERMINAL_DEFAULT_COLS = 80;

const spawnRequests: SpawnRequest[] = [];
const mounted: HTMLElement[] = [];

function installRpcBridge() {
  const bridge: ElectronRpcBridge = {
    request: async (path, req) => {
      // 想定外の path は黙って空にせず落とす。mount 中に別の RPC が増えたら気付けるように
      if (path !== "/pty/spawn") throw new Error(`unexpected RPC: ${path}`);
      const { cols, rows } = req as SpawnRequest;
      spawnRequests.push({ cols, rows });
      return { ptyId: spawnRequests.length };
    },
    onPush: () => () => {},
  };
  window.__gozdElectronRpc = bridge;
}

/**
 * 実運用と同じ入れ子。leaf は親いっぱいに広がり、表示は親の display で切り替わる。
 *
 * 器を grid にするのは、render が mount 時に中間の div を挟むため。既定の block だと
 * その div の高さが auto になり、可視でも寸法が 0 と測られて検証が空振りする。
 */
function mountArea(visible: boolean, size: { width: string; height: string }): HTMLElement {
  const outer = document.createElement("div");
  outer.style.width = size.width;
  outer.style.height = size.height;
  if (!visible) outer.style.display = "none";
  document.body.appendChild(outer);
  mounted.push(outer);

  const area = document.createElement("div");
  area.style.width = "100%";
  area.style.height = "100%";
  area.style.display = "grid";
  outer.appendChild(area);
  return area;
}

async function renderTerminal(
  dir: string,
  visible: boolean,
  size: { width: string; height: string },
): Promise<SpawnRequest> {
  const store = useTerminalStore();
  // visit が初期 leaf を作り、pane を登録する（spawn の前提）
  store.visit(dir);
  const layout = store.layoutsByDir[dir];
  if (layout === undefined) throw new Error("layout was not created");

  const expected = spawnRequests.length + 1;
  const area = mountArea(visible, size);
  // 非表示の器が本当に測れない状態であることを確かめる。測れてしまうと、実測値が
  // 器から出たのか継承されたのか区別できず、検証が空振りする
  expect(area.clientWidth > 0).toBe(visible);
  await render(XtermTerminal, {
    props: { dir, leafId: layout.focusedLeafId, visible, focused: false },
    container: area,
  });

  // onMounted は async。起動要求が飛ぶまで待つ
  await vi.waitFor(() => {
    expect(spawnRequests).toHaveLength(expected);
  });
  const request = spawnRequests[expected - 1];
  if (request === undefined) throw new Error("pty spawn was not requested");
  return request;
}

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
  spawnRequests.length = 0;
});

test("表示されていない端末は、直近に測定できた寸法で PTY を起動する", async () => {
  setActivePinia(createPinia());
  installRpcBridge();
  // 起動寸法が既定へ落ちた経路は観察ログを残す契約。これが鳴らないことが
  // 「実測が効いている」の裏付けになる。WebGL 等ここと無関係な warn も出るため、
  // 全件禁止ではなくこの経路のメッセージだけを見る
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  const measured = await renderTerminal("/wt-visible", true, { width: "800px", height: "600px" });
  // 実測。既定寸法と一致していたら測定が効いていない
  expect(measured.cols).not.toBe(TERMINAL_DEFAULT_COLS);

  // 器を変える。継承が効いていれば可視側の実測値と一致し、測ってしまった場合は
  // 器由来の別の値になって落ちる
  const hidden = await renderTerminal("/wt-hidden", false, { width: "400px", height: "300px" });

  // 実寸とかけ離れた寸法が PTY に伝わらない
  expect(hidden).toEqual(measured);
  const geometryWarnings = consoleWarn.mock.calls.filter(([message]) =>
    String(message).includes("no measured geometry"),
  );
  expect(geometryWarnings).toHaveLength(0);
  consoleWarn.mockRestore();
});
