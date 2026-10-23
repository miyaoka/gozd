import type { ElectronRpcBridge } from "@gozd/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, expect, test } from "vitest";
import { render } from "vitest-browser-vue";
import { useNotificationStore } from "../../../../shared/notification";
import { dispatchMessage } from "../../../../shared/rpc";
import type { PreviewServingTarget } from "../../previewServingTarget";
import MarkdownPreview from "./MarkdownPreview.vue";

/**
 * md を変えずに画像ファイルだけが変わったとき、画像を読み直すことを確かめる。
 * 読み直しは、同じ画像を指したまま URL が変わることで観測する（同じ URL ではページ内の画像
 * キャッシュが使われる）。
 */
const ROOT = "/gozd-browser-test/repo";
const OUTSIDE_DIR = "/gozd-browser-test/notes";
const IMAGE = '<img alt="logo" src="images/logo.png">';

/** 単一ファイル監視の要求 */
let watchRequests: string[];
let unwatchRequests: string[];
/** 単一ファイル監視を失敗させるパスと、そのときに親 dir があるか */
let failingWatch: Map<string, { parentExists: boolean }>;
/** 親 dir の存在確認に応答した回数 */
let existsResponses: number;
/** 応答を止めている監視の要求。失敗させる関数を持つ */
let heldWatches: ((error: Error) => void)[] | undefined;

function installRpcBridge() {
  watchRequests = [];
  unwatchRequests = [];
  failingWatch = new Map();
  existsResponses = 0;
  heldWatches = undefined;
  const bridge: ElectronRpcBridge = {
    request: (path, body) => {
      if (path === "/preview/releaseServing") return Promise.resolve({});
      if (path === "/preview/servingUrl") {
        const req = body as { absPath: string; previewId: string };
        return Promise.resolve({ url: `gozd-preview://${req.previewId}${req.absPath}` });
      }
      if (path === "/fs/watchFileAbsolute") {
        const absolutePath = (body as { absolutePath: string }).absolutePath;
        watchRequests.push(absolutePath);
        const held = heldWatches;
        if (held !== undefined) return new Promise((_, reject) => held.push(reject));
        if (failingWatch.has(absolutePath)) return Promise.reject(new Error("watch failed"));
        return Promise.resolve({});
      }
      if (path === "/fs/unwatchFileAbsolute") {
        unwatchRequests.push((body as { absolutePath: string }).absolutePath);
        return Promise.resolve({});
      }
      if (path === "/fs/existsAbsolute") {
        const paths = (body as { absolutePaths: string[] }).absolutePaths;
        const exists = paths.map(
          (dir) =>
            ![...failingWatch].some(
              ([file, { parentExists }]) => file.startsWith(`${dir}/`) && !parentExists,
            ),
        );
        existsResponses++;
        return Promise.resolve({ exists });
      }
      throw new Error(`unexpected RPC: ${path}`);
    },
    onPush: () => {},
  };
  window.__gozdElectronRpc = bridge;
}

beforeEach(() => {
  installRpcBridge();
  setActivePinia(createPinia());
  useNotificationStore().clear();
});

async function renderPreview(target: PreviewServingTarget, content = IMAGE) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const screen = await render(MarkdownPreview, { container, props: { content, target } });
  const src = () => container.querySelector('img[alt="logo"]')?.getAttribute("src") ?? null;
  await expect.poll(src).toMatch(/^gozd-preview:/);
  return { container, src, screen };
}

const WORKTREE_TARGET: PreviewServingTarget = {
  absPath: `${ROOT}/README.md`,
  root: ROOT,
  scope: "worktree",
};
const OUTSIDE_TARGET: PreviewServingTarget = {
  absPath: `${OUTSIDE_DIR}/a.md`,
  root: OUTSIDE_DIR,
  scope: "directory",
};

/** 同じ画像を指したまま URL だけが変わったか */
function reloadedSameImage(before: string | null, after: string | null): boolean {
  if (before === null || after === null || before === after) return false;
  return new URL(before).pathname === new URL(after).pathname;
}

for (const [label, target, imagePath] of [
  ["worktree 内", WORKTREE_TARGET, `${ROOT}/images/logo.png`],
  ["worktree 外", OUTSIDE_TARGET, `${OUTSIDE_DIR}/images/logo.png`],
] as const) {
  test(`${label}: 画像ごとに監視を張り、その画像の変更で同じ画像を読み直す`, async () => {
    const { src, screen } = await renderPreview(target);
    await expect.poll(() => watchRequests).toEqual([imagePath]);
    const before = src();

    dispatchMessage("fsChangeAbsolute", { path: imagePath });

    await expect.poll(() => reloadedSameImage(before, src())).toBe(true);

    await screen.unmount();
    await expect.poll(() => unwatchRequests).toEqual([imagePath]);
  });
}

test("画像と関係の無い変更では読み直さない", async () => {
  const { src } = await renderPreview(WORKTREE_TARGET);
  const imagePath = `${ROOT}/images/logo.png`;
  await expect.poll(() => watchRequests).toEqual([imagePath]);

  // 画像と同じ dir の別ファイル、md 自身、worktree 全体の監視の通知
  dispatchMessage("fsChangeAbsolute", { path: `${ROOT}/images/other.png` });
  dispatchMessage("fsChangeAbsolute", { path: `${ROOT}/README.md` });
  dispatchMessage("fsChange", { dir: ROOT, relDir: "images" });
  // 関係のある変更を最後に送る。版数が 1 回しか進んでいなければ、先の 3 件は無視されている
  dispatchMessage("fsChangeAbsolute", { path: imagePath });

  await expect.poll(src).toMatch(/\?e=/);
  expect(new URL(src() ?? "").searchParams.get("e")).toBe("1");
});

test("親 dir が無い画像（壊れた参照）は監視できなくても通知しない", async () => {
  const missing = `${OUTSIDE_DIR}/missing/logo.png`;
  failingWatch.set(missing, { parentExists: false });
  await renderPreview(OUTSIDE_TARGET, '<img alt="logo" src="missing/logo.png">');
  await expect.poll(() => watchRequests).toEqual([missing]);

  // 存在確認の応答を待ち、その後の通知判定（応答直後の microtask）まで進めてから確かめる
  await expect.poll(() => existsResponses).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(useNotificationStore().notifications.value).toEqual([]);
});

test("親 dir がある画像の監視に失敗したら通知する", async () => {
  const path = `${OUTSIDE_DIR}/images/logo.png`;
  failingWatch.set(path, { parentExists: true });
  await renderPreview(OUTSIDE_TARGET);

  await expect.poll(() => useNotificationStore().notifications.value.length).toBe(1);
});

test("mermaid を含む markdown でも、描画の重なりで画像の監視が外れない", async () => {
  const content = `${IMAGE}\n\n\`\`\`mermaid\ngraph TD\n  A --> B\n\`\`\`\n`;
  const { container, src } = await renderPreview(WORKTREE_TARGET, content);
  const imagePath = `${ROOT}/images/logo.png`;
  await expect.poll(() => container.querySelector("svg")).not.toBeNull();
  await expect.poll(() => watchRequests).toContain(imagePath);
  const before = src();

  dispatchMessage("fsChangeAbsolute", { path: imagePath });

  await expect.poll(() => reloadedSameImage(before, src())).toBe(true);
});

test("表示から外れた画像の監視が後から失敗しても、通知も後始末もしない", async () => {
  const held: ((error: Error) => void)[] = [];
  heldWatches = held;
  const { screen } = await renderPreview(WORKTREE_TARGET);
  await expect.poll(() => held.length).toBe(1);

  await screen.unmount();
  for (const reject of held) reject(new Error("watch failed"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(existsResponses).toBe(0);
  expect(useNotificationStore().notifications.value).toEqual([]);
});
