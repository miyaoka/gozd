import { describe, expect, test } from "bun:test";
import { stripTrailingPunctuation } from "./stripTrailingPunctuation";

describe("stripTrailingPunctuation", () => {
  test("対応する開き括弧が無い閉じ括弧を落とす", () => {
    expect(stripTrailingPunctuation("http://example.com)")).toBe("http://example.com");
  });

  test("対応する開き括弧がある閉じ括弧は残す", () => {
    expect(stripTrailingPunctuation("https://en.wikipedia.org/wiki/Rust_(video_game)")).toBe(
      "https://en.wikipedia.org/wiki/Rust_(video_game)",
    );
  });

  test("括弧の後にパスが続く URL を壊さない", () => {
    expect(stripTrailingPunctuation("https://example.com/a_(b)/c")).toBe(
      "https://example.com/a_(b)/c",
    );
  });

  test("角括弧と波括弧も同じ規則で扱う", () => {
    expect(stripTrailingPunctuation("http://example.com]")).toBe("http://example.com");
    expect(stripTrailingPunctuation("http://example.com/[a]")).toBe("http://example.com/[a]");
    expect(stripTrailingPunctuation("http://example.com}")).toBe("http://example.com");
  });

  test("末尾の ASCII 約物を落とす", () => {
    expect(stripTrailingPunctuation("http://example.com.")).toBe("http://example.com");
    expect(stripTrailingPunctuation("http://example.com,")).toBe("http://example.com");
    expect(stripTrailingPunctuation("http://example.com?")).toBe("http://example.com");
  });

  test("末尾の全角約物を落とす", () => {
    expect(stripTrailingPunctuation("http://example.com）")).toBe("http://example.com");
    expect(stripTrailingPunctuation("http://example.com。")).toBe("http://example.com");
  });

  test("連続した約物をまとめて落とす", () => {
    expect(stripTrailingPunctuation("http://example.com).")).toBe("http://example.com");
  });

  test("URL に意味のある末尾文字は残す", () => {
    expect(stripTrailingPunctuation("http://example.com/")).toBe("http://example.com/");
    expect(stripTrailingPunctuation("http://example.com/a-b")).toBe("http://example.com/a-b");
    expect(stripTrailingPunctuation("http://example.com/a_b")).toBe("http://example.com/a_b");
    expect(stripTrailingPunctuation("http://example.com/#frag")).toBe("http://example.com/#frag");
    expect(stripTrailingPunctuation("http://example.com/?a=1")).toBe("http://example.com/?a=1");
    expect(stripTrailingPunctuation("http://example.com/%E6%97%A5")).toBe(
      "http://example.com/%E6%97%A5",
    );
  });

  test("パス末尾の日本語は残す", () => {
    expect(stripTrailingPunctuation("https://example.com/日本語ページ")).toBe(
      "https://example.com/日本語ページ",
    );
  });

  test("空文字を受け取っても落ちない", () => {
    expect(stripTrailingPunctuation("")).toBe("");
  });
});
