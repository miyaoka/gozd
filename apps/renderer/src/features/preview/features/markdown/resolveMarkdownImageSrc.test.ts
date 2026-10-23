import { describe, expect, test } from "bun:test";
import { normalizeAbsolute } from "../../../worktree";
import { markdownImageBase, resolveMarkdownImageSrc } from "./resolveMarkdownImageSrc";

const ROOT = "/Users/me/repo";
const ORIGIN = "gozd-preview://p1";

/** main の pathToPreviewUrl と同じ形の URL（root 配下の md 自身） */
function baseFor(relPath: string) {
  return markdownImageBase(`${ORIGIN}${ROOT}/${relPath}`, `${ROOT}/${relPath}`, ROOT);
}

function resolve(src: string, base: ReturnType<typeof baseFor> | undefined) {
  return resolveMarkdownImageSrc(src, base, normalizeAbsolute);
}

describe("resolveMarkdownImageSrc", () => {
  test("相対 src は markdown の dir 基準で解決する", () => {
    expect(resolve("docs/images/logo.png", baseFor("README.md"))).toBe(
      `${ORIGIN}${ROOT}/docs/images/logo.png`,
    );
    expect(resolve("../img/a.svg", baseFor("docs/guide/a.md"))).toBe(
      `${ORIGIN}${ROOT}/docs/img/a.svg`,
    );
  });

  test("`/` 始まりは root 基準で解決する", () => {
    expect(resolve("/docs/a.png", baseFor("docs/guide/a.md"))).toBe(`${ORIGIN}${ROOT}/docs/a.png`);
  });

  test("root の外を指す src は読ませない", () => {
    expect(resolve("../../x.png", baseFor("docs/a.md"))).toBeUndefined();
    expect(resolve("../../../../../etc/x.png", baseFor("README.md"))).toBeUndefined();
    expect(resolve("%2e%2e/%2e%2e/x.png", baseFor("docs/a.md"))).toBeUndefined();
  });

  test("encode された区切りで root の外を指す src も読ませない", () => {
    expect(resolve("..%2F..%2F..%2Fetc%2Fpasswd", baseFor("docs/a.md"))).toBeUndefined();
    expect(resolve("x%2F..%2F..%2F..%2Fy.png", baseFor("README.md"))).toBeUndefined();
  });

  test("encode された区切りでも root 内に留まる src は読ませる", () => {
    expect(resolve("docs%2Fa.png", baseFor("README.md"))).toBe(`${ORIGIN}${ROOT}/docs%2Fa.png`);
  });

  test("root と同名で始まる兄弟 dir は root の外として扱う", () => {
    expect(resolve("../repo-other/x.png", baseFor("README.md"))).toBeUndefined();
  });

  test("scheme 付きはそのまま返す", () => {
    for (const src of ["https://img.shields.io/a", "data:image/png;base64,AA"]) {
      expect(resolve(src, baseFor("README.md"))).toBe(src);
      expect(resolve(src, undefined)).toBe(src);
    }
  });

  test("protocol-relative は https を補う", () => {
    expect(resolve("//cdn.example/a.png", baseFor("README.md"))).toBe("https://cdn.example/a.png");
    expect(resolve("//cdn.example/a.png", undefined)).toBe("https://cdn.example/a.png");
  });

  test("base が未確定なら相対 src は読ませない", () => {
    expect(resolve("docs/a.png", undefined)).toBeUndefined();
  });
});
