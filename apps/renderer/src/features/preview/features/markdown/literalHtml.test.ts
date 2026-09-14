import { describe, expect, test } from "bun:test";
import { Marked } from "marked";
import { literalHtmlExtension } from "./literalHtml";

const markdown = new Marked(literalHtmlExtension);

describe("literalHtmlExtension", () => {
  // 既定の marked はタグを素通しし、sanitizer が未知の要素を中身だけ残して消す / 既知の要素にする
  test("インラインのタグを書かれた文字のまま出す", () => {
    expect(markdown.parse("型は Array<string> にする")).toBe(
      "<p>型は Array&lt;string&gt; にする</p>\n",
    );
    expect(markdown.parse("<Button> を置き換える")).toBe("<p>&lt;Button&gt; を置き換える</p>\n");
  });

  test("ブロックの HTML を書かれた文字のまま出す", () => {
    expect(markdown.parse("<details><summary>s</summary>body</details>")).toBe(
      "&lt;details&gt;&lt;summary&gt;s&lt;/summary&gt;body&lt;/details&gt;",
    );
  });

  test("HTML でない markdown の書式はそのまま描画する", () => {
    expect(markdown.parse("**b** と `Array<string>`")).toBe(
      "<p><strong>b</strong> と <code>Array&lt;string&gt;</code></p>\n",
    );
  });
});
