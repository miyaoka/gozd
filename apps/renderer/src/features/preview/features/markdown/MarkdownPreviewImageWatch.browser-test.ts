import type { ElectronRpcBridge } from "@gozd/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, expect, test } from "vitest";
import { render } from "vitest-browser-vue";
import { dispatchMessage } from "../../../../shared/rpc";
import type { PreviewServingTarget } from "../../previewServingTarget";
import MarkdownPreview from "./MarkdownPreview.vue";

/**
 * md を変えずに画像ファイルだけが変わったとき、画像を読み直すことを確かめる。
 * 読み直しは画像の URL が変わることで観測する（同じ URL ではページ内の画像キャッシュが使われる）。
 */
const ROOT = "/gozd-browser-test/repo";
const OUTSIDE_DIR = "/gozd-browser-test/notes";
const CONTENT = '<img alt="logo" src="images/logo.png">';

/** 単一ファイル監視の要求。worktree 外の markdown で画像ごとに張られる */
let watchRequests: string[];
let unwatchRequests: string[];

function installRpcBridge() {
  watchRequests = [];
  unwatchRequests = [];
  const bridge: ElectronRpcBridge = {
    request: (path, body) => {
      if (path === "/preview/releaseServing") return Promise.resolve({});
      if (path === "/preview/servingUrl") {
        const req = body as { absPath: string; previewId: string };
        return Promise.resolve({ url: `gozd-preview://${req.previewId}${req.absPath}` });
      }
      if (path === "/fs/watchFileAbsolute") {
        watchRequests.push((body as { absolutePath: string }).absolutePath);
        return Promise.resolve({});
      }
      if (path === "/fs/unwatchFileAbsolute") {
        unwatchRequests.push((body as { absolutePath: string }).absolutePath);
        return Promise.resolve({});
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
});

async function renderPreview(target: PreviewServingTarget) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const screen = await render(MarkdownPreview, { container, props: { content: CONTENT, target } });
  const src = () => container.querySelector('img[alt="logo"]')?.getAttribute("src") ?? null;
  await expect.poll(src).toMatch(/^gozd-preview:/);
  return { src, screen };
}

const WORKTREE_TARGET: PreviewServingTarget = {
  absPath: `${ROOT}/README.md`,
  root: ROOT,
  scope: "worktree",
};

test("worktree 内: 画像の親 dir の変更で画像の URL が変わる", async () => {
  const { src } = await renderPreview(WORKTREE_TARGET);
  const before = src();

  dispatchMessage("fsChange", { dir: ROOT, relDir: "images" });

  await expect.poll(src).not.toBe(before);
  expect(src()).toMatch(/\/gozd-browser-test\/repo\/images\/logo\.png\?e=1$/);
});

test("worktree 内: 画像と関係の無い変更では読み直さない", async () => {
  const { src } = await renderPreview(WORKTREE_TARGET);
  const before = src();

  dispatchMessage("fsChange", { dir: ROOT, relDir: "" });
  dispatchMessage("fsChange", { dir: ROOT, relDir: "src" });
  dispatchMessage("fsChange", { dir: "/gozd-browser-test/other", relDir: "images" });
  // 反映を待つ時間を置いてから、変わっていないことを確かめる
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(src()).toBe(before);
});

test("worktree 外: 画像ごとに単一ファイル監視を張り、その変更で画像の URL が変わる", async () => {
  const { src, screen } = await renderPreview({
    absPath: `${OUTSIDE_DIR}/a.md`,
    root: OUTSIDE_DIR,
    scope: "directory",
  });
  const imagePath = `${OUTSIDE_DIR}/images/logo.png`;
  await expect.poll(() => watchRequests).toEqual([imagePath]);
  const before = src();

  dispatchMessage("fsChangeAbsolute", { path: imagePath });

  await expect.poll(src).not.toBe(before);
  expect(src()).toMatch(/\/gozd-browser-test\/notes\/images\/logo\.png\?e=1$/);

  await screen.unmount();
  await expect.poll(() => unwatchRequests).toEqual([imagePath]);
});
