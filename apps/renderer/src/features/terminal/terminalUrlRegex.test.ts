import { describe, expect, test } from "bun:test";
import { TERMINAL_URL_REGEX } from "./terminalUrlRegex";

/** WebLinksAddon の LinkComputer と同じく g フラグを足して行全体を走査する */
const findUrls = (line: string): string[] => {
  const flags = TERMINAL_URL_REGEX.flags.includes("g")
    ? TERMINAL_URL_REGEX.flags
    : `${TERMINAL_URL_REGEX.flags}g`;
  return [...line.matchAll(new RegExp(TERMINAL_URL_REGEX.source, flags))].map(([match]) => match);
};

describe("TERMINAL_URL_REGEX", () => {
  test("空白区切りの URL を検出する", () => {
    expect(findUrls("see https://example.com/a and more")).toEqual(["https://example.com/a"]);
  });

  test("クエリと fragment を含めて検出する", () => {
    expect(findUrls("https://example.com/p?a=1&b=2#frag です")).toEqual([
      "https://example.com/p?a=1&b=2#frag",
    ]);
  });

  test("percent-encode されたパスを検出する", () => {
    expect(findUrls("https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC を開く")).toEqual([
      "https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC",
    ]);
  });

  test("末尾のハイフンを含む語を切らない", () => {
    expect(findUrls("https://example.com/some-page-name です")).toEqual([
      "https://example.com/some-page-name",
    ]);
  });

  test("markdown リンクの半角括弧で終端する", () => {
    expect(findUrls("[記事](https://example.com/ja/articles/9334656) のため")).toEqual([
      "https://example.com/ja/articles/9334656",
    ]);
  });

  test("全角括弧で終端する", () => {
    expect(findUrls("[記事](https://example.com/ja/articles/9334656）のため旧IP問題")).toEqual([
      "https://example.com/ja/articles/9334656",
    ]);
  });

  test("句点で終端する", () => {
    expect(findUrls("詳細はhttps://example.com/a。次の文")).toEqual(["https://example.com/a"]);
  });

  test("読点で終端する", () => {
    expect(findUrls("https://example.com/path、および")).toEqual(["https://example.com/path"]);
  });

  test("パス中の日本語は URL の一部として通す", () => {
    expect(findUrls("https://example.com/日本語ページ を開く")).toEqual([
      "https://example.com/日本語ページ",
    ]);
  });

  test("URL 内で閉じた括弧は構成要素として含める", () => {
    expect(findUrls("https://en.wikipedia.org/wiki/Rust_(video_game) を見る")).toEqual([
      "https://en.wikipedia.org/wiki/Rust_(video_game)",
    ]);
  });

  test("括弧の後にパスが続く URL を切らない", () => {
    expect(findUrls("https://example.com/a_(b)/c です")).toEqual(["https://example.com/a_(b)/c"]);
  });

  test("括弧内に日本語があっても含める", () => {
    expect(findUrls("https://ja.wikipedia.org/wiki/Rust_(ゲーム) を見る")).toEqual([
      "https://ja.wikipedia.org/wiki/Rust_(ゲーム)",
    ]);
  });

  test("URL を囲う括弧は含めない", () => {
    expect(findUrls("(https://example.com/x) を見る")).toEqual(["https://example.com/x"]);
  });

  test("markdown リンク内の括弧入り URL を検出する", () => {
    expect(findUrls("[記事](https://en.wikipedia.org/wiki/Rust_(video_game)) のため")).toEqual([
      "https://en.wikipedia.org/wiki/Rust_(video_game)",
    ]);
  });

  test("閉じない開き括弧は含めない", () => {
    expect(findUrls("https://example.com/a( です")).toEqual(["https://example.com/a"]);
  });

  test("1 行に複数の URL があればすべて検出する", () => {
    expect(findUrls("https://a.example.com/x と https://b.example.com/y")).toEqual([
      "https://a.example.com/x",
      "https://b.example.com/y",
    ]);
  });
});
