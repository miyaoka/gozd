import type { ElectronRpcBridge } from "@gozd/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, expect, test } from "vitest";
import { render } from "vitest-browser-vue";
import MarkdownPreview from "./MarkdownPreview.vue";

/**
 * `<img src>` の書き換えを実ブラウザで確かめる。対象は bun では見えない、sanitizer の hook が
 * 要素を DOM に入れる前に src を差し替えること。
 */
const ROOT = "/gozd-browser-test/repo";
const ABS_PATH = `${ROOT}/README.md`;

/** 配信 URL の要求回数。同じ対象の再選択で取り直していないかを見る */
let servingUrlCalls = 0;

/** main の pathToPreviewUrl と同じ形で返す。想定外の RPC は黙って空にせず落とす */
function installRpcBridge() {
  servingUrlCalls = 0;
  const bridge: ElectronRpcBridge = {
    request: (path, body) => {
      if (path === "/preview/releaseServing") return Promise.resolve({});
      if (path !== "/preview/servingUrl") throw new Error(`unexpected RPC: ${path}`);
      servingUrlCalls++;
      const req = body as { absPath: string; previewId: string };
      return Promise.resolve({ url: `gozd-preview://${req.previewId}${req.absPath}` });
    },
    onPush: () => {},
  };
  window.__gozdElectronRpc = bridge;
}

beforeEach(() => {
  installRpcBridge();
  setActivePinia(createPinia());
});

const CONTENT = [
  '<img alt="relative" src="docs/images/logo.png">',
  "![root-relative](/img/b.svg)",
  '<img alt="escape" src="../outside.png">',
  '<img alt="authored-scheme" src="gozd-preview://other/etc/passwd">',
  '<img alt="external" src="https://img.shields.io/badge/a-b-c">',
  '<img alt="srcset" src="docs/a.png" srcset="docs/a.png 1x, gozd-preview://other/x.png 2x, ../outside.png 3x">',
  '<picture><source id="picture-source" srcset="docs/b.png 1x, docs/b@2x.png 2x"><img alt="picture" src="docs/c.png"></picture>',
].join("\n\n");

function srcOf(container: Element, alt: string): string | null {
  const img = container.querySelector(`img[alt="${alt}"]`);
  if (img === null) throw new Error(`img not rendered: ${alt}`);
  return img.getAttribute("src");
}

async function renderPreview(): Promise<Element> {
  const { container } = await renderPreviewScreen();
  return container;
}

async function renderPreviewScreen() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const screen = await render(MarkdownPreview, {
    container,
    props: { content: CONTENT, target: { absPath: ABS_PATH, root: ROOT, scope: "worktree" } },
  });
  return { container, screen };
}

test("相対 src を配信 scheme の URL に書き換え、範囲外と直書きの scheme は読ませない", async () => {
  const container = await renderPreview();

  await expect
    .poll(() => srcOf(container, "relative"))
    .toMatch(/^gozd-preview:\/\/[a-z0-9-]+\/gozd-browser-test\/repo\/docs\/images\/logo\.png$/);
  expect(srcOf(container, "root-relative")).toMatch(
    /^gozd-preview:\/\/[a-z0-9-]+\/gozd-browser-test\/repo\/img\/b\.svg$/,
  );
  expect(srcOf(container, "escape")).toBeNull();
  expect(srcOf(container, "authored-scheme")).toBeNull();
  expect(srcOf(container, "external")).toBe("https://img.shields.io/badge/a-b-c");
});

test("配信 URL の取得前は相対 src を DOM に入れない", async () => {
  window.__gozdElectronRpc = {
    request: (path) =>
      path === "/preview/servingUrl" ? new Promise(() => {}) : Promise.resolve({}),
    onPush: () => {},
  };
  const container = await renderPreview();

  await expect.poll(() => container.querySelector('img[alt="relative"]')).not.toBeNull();
  expect(srcOf(container, "relative")).toBeNull();
  expect(srcOf(container, "external")).toBe("https://img.shields.io/badge/a-b-c");
});

test("同じ対象を別の object で渡し直しても、画像の src を外さず配信 URL を取り直さない", async () => {
  const { container, screen } = await renderPreviewScreen();
  await expect.poll(() => srcOf(container, "relative")).toMatch(/^gozd-preview:/);
  const before = srcOf(container, "relative");

  await screen.rerender({
    content: CONTENT,
    target: { absPath: ABS_PATH, root: ROOT, scope: "worktree" },
  });

  expect(srcOf(container, "relative")).toBe(before);
  expect(servingUrlCalls).toBe(1);
});

const SERVED = /^gozd-preview:\/\/[a-z0-9-]+\/gozd-browser-test\/repo/;

test("srcset の各候補を書き換え、範囲外と直書きの scheme の候補は落とす", async () => {
  const container = await renderPreview();
  await expect.poll(() => srcOf(container, "srcset")).toMatch(SERVED);

  const srcset = container.querySelector('img[alt="srcset"]')?.getAttribute("srcset") ?? "";
  const candidates = srcset.split(", ");
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatch(
    /^gozd-preview:\/\/[a-z0-9-]+\/gozd-browser-test\/repo\/docs\/a\.png 1x$/,
  );

  const sourceSrcset = container.querySelector("#picture-source")?.getAttribute("srcset") ?? "";
  const sourceCandidates = sourceSrcset.split(", ");
  expect(sourceCandidates).toHaveLength(2);
  expect(sourceCandidates[0]).toMatch(/\/docs\/b\.png 1x$/);
  expect(sourceCandidates[1]).toMatch(/\/docs\/b@2x\.png 2x$/);
  for (const candidate of sourceCandidates) expect(candidate).toMatch(SERVED);
});
