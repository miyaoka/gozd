import { expect, test } from "vitest";
import { render } from "vitest-browser-vue";
import { getFolderIconUrl } from "../features/filer";
import { ResizeHandle } from "../shared/ui";
import IconLucideChevronRight from "~icons/lucide/chevron-right";

/**
 * browser mode の土台が実アプリと同じ材料で組めていることを確かめる。
 *
 * このモードの意義はレイアウト・実 CSS・実アセットをそのまま観測できる点にある。材料の
 * どれか（SFC コンパイル / Tailwind / icon の virtual module / material-icon-theme の asset
 * 解決）が欠けると、テストは通るのに観測しているものが実物と別物になる。ここが落ちたら
 * 個々のテストではなく `vite.config.ts` の `test` か `vitest.setup.ts` を見る。
 */
test("SFC renders with Tailwind styles and real layout", async () => {
  const screen = await render(ResizeHandle, {
    props: { direction: "horizontal", beforeMinSize: 0, afterMinSize: 0 },
  });
  const handle = screen.container.firstElementChild;
  if (handle === null) throw new Error("component did not render");

  expect(getComputedStyle(handle).display).toBe("flex");
  expect(handle.getBoundingClientRect().width).toBeGreaterThan(0);

  // semantic alias -> primitive の解決チェーンが通っている。切れると utility は出るが
  // 色だけ透明へ倒れるため、display だけを見ていると気付けない
  const surface = handle.firstElementChild;
  if (surface === null) throw new Error("component did not render its surface");
  expect(getComputedStyle(surface).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
});

test("unplugin-icons virtual module resolves", async () => {
  const screen = await render(IconLucideChevronRight);

  expect(screen.container.querySelector("svg")).not.toBeNull();
});

test("material-icon-theme assets resolve through the Vite glob", () => {
  expect(getFolderIconUrl("src", false)).toMatch(/\.svg/);
});
