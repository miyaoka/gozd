import { describe, expect, test } from "bun:test";
import { markdownImageBase, resolveMarkdownImageSrc } from "./resolveMarkdownImageSrc";

const ROOT = "/Users/me/repo";
const ORIGIN = "gozd-preview://p1";

/** main の pathToPreviewUrl と同じ形の URL（root 配下の md 自身） */
function baseFor(relPath: string) {
  return markdownImageBase(`${ORIGIN}${ROOT}/${relPath}`, `${ROOT}/${relPath}`, ROOT);
}

describe("markdownImageBase", () => {
  test("root 直下の markdown は root URL を自身の dir にする", () => {
    expect(baseFor("README.md").rootUrl).toBe(`${ORIGIN}${ROOT}/`);
  });

  test("深い markdown からも root URL に戻る", () => {
    expect(baseFor("docs/guide/a.md").rootUrl).toBe(`${ORIGIN}${ROOT}/`);
  });
});

describe("resolveMarkdownImageSrc", () => {
  test("相対 src は markdown の dir 基準で解決する", () => {
    expect(resolveMarkdownImageSrc("docs/images/logo.png", baseFor("README.md"))).toBe(
      `${ORIGIN}${ROOT}/docs/images/logo.png`,
    );
    expect(resolveMarkdownImageSrc("../img/a.svg", baseFor("docs/guide/a.md"))).toBe(
      `${ORIGIN}${ROOT}/docs/img/a.svg`,
    );
  });

  test("`/` 始まりは root 基準で解決する", () => {
    expect(resolveMarkdownImageSrc("/docs/a.png", baseFor("docs/guide/a.md"))).toBe(
      `${ORIGIN}${ROOT}/docs/a.png`,
    );
  });

  test("root の外を指す src は読ませない", () => {
    expect(resolveMarkdownImageSrc("../../x.png", baseFor("docs/a.md"))).toBeUndefined();
    expect(
      resolveMarkdownImageSrc("../../../../../etc/x.png", baseFor("README.md")),
    ).toBeUndefined();
    expect(resolveMarkdownImageSrc("%2e%2e/%2e%2e/x.png", baseFor("docs/a.md"))).toBeUndefined();
  });

  test("root と同名で始まる兄弟 dir は root の外として扱う", () => {
    expect(resolveMarkdownImageSrc("../repo-other/x.png", baseFor("README.md"))).toBeUndefined();
  });

  test("scheme 付きと protocol-relative はそのまま返す", () => {
    for (const src of ["https://img.shields.io/a", "data:image/png;base64,AA", "//cdn.example/a"]) {
      expect(resolveMarkdownImageSrc(src, baseFor("README.md"))).toBe(src);
      expect(resolveMarkdownImageSrc(src, undefined)).toBe(src);
    }
  });

  test("base が未確定なら相対 src は読ませない", () => {
    expect(resolveMarkdownImageSrc("docs/a.png", undefined)).toBeUndefined();
  });
});
