import { expect, test } from "vitest";
import { sanitizeMarkdownHtml } from "./sanitizeMarkdownHtml";

/**
 * 書き換え関数を渡さない利用側（session log 等）での srcset を確かめる。DOMPurify の URI allowlist は
 * 属性値の先頭しか見ないため、2 つ目以降の候補の scheme は実ブラウザの sanitize で確かめる。
 */
test("書き換え関数が無くても、srcset の候補の配信 scheme と未知の scheme は落とす", () => {
  const html = sanitizeMarkdownHtml(
    '<img srcset="a.png 1x, gozd-preview://other/etc/passwd 2x, file:///etc/x 3x, https://e.example/b.png 4x">',
    undefined,
  );
  const img = new DOMParser().parseFromString(html, "text/html").querySelector("img");
  expect(img?.getAttribute("srcset")).toBe("a.png 1x, https://e.example/b.png 4x");
});

test("書き換え関数が無くても、制御文字を前に付けた配信 scheme の候補は落とす", () => {
  const html = sanitizeMarkdownHtml(
    '<img srcset="a.png 1x, &#1;gozd-preview://other/etc/passwd 2x">',
    undefined,
  );
  const img = new DOMParser().parseFromString(html, "text/html").querySelector("img");
  expect(img?.getAttribute("srcset")).toBe("a.png 1x");
});

test("書き換え関数が無くても、括弧で descriptor に紛れ込ませた配信 scheme の候補は読ませない", () => {
  const html = sanitizeMarkdownHtml(
    '<img srcset="a.png ((x) , gozd-preview://other/etc/passwd 2x, b.png 2x">',
    undefined,
  );
  const img = new DOMParser().parseFromString(html, "text/html").querySelector("img");
  expect(img?.getAttribute("srcset")).toBe("b.png 2x");
});
