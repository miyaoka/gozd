import { describe, expect, test } from "bun:test";
import { rewriteSrcset } from "./rewriteSrcset";

/** 相対 URL に印を付け、`bad` を含むものは落とす */
function rewrite(url: string): string | undefined {
  if (url.includes("bad")) return undefined;
  return /^[a-z]+:/i.test(url) ? url : `R(${url})`;
}

describe("rewriteSrcset", () => {
  test("各候補の URL を書き換え、descriptor は残す", () => {
    expect(rewriteSrcset("a.png 1x, b.png 2x", rewrite)).toBe("R(a.png) 1x, R(b.png) 2x");
    expect(rewriteSrcset("a.png 480w,b.png 800w", rewrite)).toBe("R(a.png) 480w, R(b.png) 800w");
  });

  test("descriptor の無い候補も扱う", () => {
    expect(rewriteSrcset("a.png", rewrite)).toBe("R(a.png)");
    expect(rewriteSrcset("a.png, b.png 2x", rewrite)).toBe("R(a.png), R(b.png) 2x");
  });

  test("URL の途中のカンマは区切りにしない", () => {
    expect(rewriteSrcset("data:image/png;base64,AAA= 1x, b.png 2x", rewrite)).toBe(
      "data:image/png;base64,AAA= 1x, R(b.png) 2x",
    );
  });

  test("書き換えで落ちた候補だけを除く", () => {
    expect(rewriteSrcset("bad.png 1x, b.png 2x", rewrite)).toBe("R(b.png) 2x");
  });

  test("括弧は入れ子にならない。閉じた後のカンマは候補の区切りになる", () => {
    expect(rewriteSrcset("a.png ((x) , bad.png 2x", rewrite)).toBeUndefined();
    expect(rewriteSrcset("a.png ((x) , b.png 2x", rewrite)).toBe("R(b.png) 2x");
  });

  test("文法に合わない descriptor の候補は落とし、descriptor の生の文字列を出力しない", () => {
    expect(rewriteSrcset("a.png 2x junk, b.png 1.5x", rewrite)).toBe("R(b.png) 1.5x");
    expect(rewriteSrcset("a.png 480w 300h", rewrite)).toBe("R(a.png) 480w 300h");
  });

  test("書き換えた URL が区切り（末尾のカンマ・ASCII 空白）を含む候補は落とす", () => {
    expect(rewriteSrcset("a.png 1x, b.png 2x", () => "x.png,")).toBeUndefined();
    expect(rewriteSrcset("a.png 1x", () => "x .png")).toBeUndefined();
    expect(rewriteSrcset("a.png 1x, b.png 2x", (url) => (url === "a.png" ? "x.png," : url))).toBe(
      "b.png 2x",
    );
  });

  test("候補が残らなければ undefined", () => {
    expect(rewriteSrcset("bad.png 1x, bad2.png 2x", rewrite)).toBeUndefined();
    expect(rewriteSrcset("  ", rewrite)).toBeUndefined();
  });
});
