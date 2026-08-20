import { describe, expect, test } from "bun:test";
import { stripTrailingPunctuation } from "./stripTrailingPunctuation";
import { TERMINAL_URL_REGEX } from "./terminalUrlRegex";
import { TRAILING_EXCLUDED_ASCII } from "./urlBoundary";

/** 自動検出が拾う範囲 */
const detect = (line: string): string | undefined => {
  const flags = TERMINAL_URL_REGEX.flags.includes("g")
    ? TERMINAL_URL_REGEX.flags
    : `${TERMINAL_URL_REGEX.flags}g`;
  return [...line.matchAll(new RegExp(TERMINAL_URL_REGEX.source, flags))].at(0)?.[0];
};

describe("URL の終端は経路によらず一致する", () => {
  const base = "https://example.com/path";

  test.each([...TRAILING_EXCLUDED_ASCII])("末尾の %j は両経路とも落とす", (char) => {
    expect(detect(`${base}${char} rest`)).toBe(base);
    expect(stripTrailingPunctuation(`${base}${char}`)).toBe(base);
  });

  test.each(["）", "。", "、", "」", "！", "？"])("末尾の全角 %s は両経路とも落とす", (char) => {
    expect(detect(`${base}${char}続き`)).toBe(base);
    expect(stripTrailingPunctuation(`${base}${char}`)).toBe(base);
  });

  test.each(["/", "-", "_", "=", "&", "+", "%", "#", "$", "@"])(
    "末尾の %s は両経路とも残す",
    (char) => {
      expect(detect(`${base}${char} rest`)).toBe(`${base}${char}`);
      expect(stripTrailingPunctuation(`${base}${char}`)).toBe(`${base}${char}`);
    },
  );

  test("対応の取れた括弧は両経路とも残す", () => {
    const url = "https://en.wikipedia.org/wiki/Rust_(video_game)";
    expect(detect(`${url} rest`)).toBe(url);
    expect(stripTrailingPunctuation(url)).toBe(url);
  });

  test("対応の無い閉じ括弧は両経路とも落とす", () => {
    expect(detect(`(${base}) rest`)).toBe(base);
    expect(stripTrailingPunctuation(`${base})`)).toBe(base);
  });

  test.each(["(", "[", "{"])("対応の無い開き括弧 %s も両経路とも落とす", (char) => {
    expect(detect(`${base}${char} rest`)).toBe(base);
    expect(stripTrailingPunctuation(`${base}${char}`)).toBe(base);
  });

  // 終端集合は \p{P} と \p{S} の 2 つからなる。BMP 外について両方を踏む
  test.each(["\u{1039F}", "\u{11047}", "\u{16E97}"])(
    "BMP 外の約物（\\p{P}）%s も両経路とも落とす",
    (char) => {
      expect(detect(`${base}${char} rest`)).toBe(base);
      expect(stripTrailingPunctuation(`${base}${char}`)).toBe(base);
    },
  );

  test.each(["\u{1F600}", "\u{1F680}", "\u{1F676}"])(
    "BMP 外の記号（\\p{S}）%s も両経路とも落とす",
    (char) => {
      expect(detect(`${base}${char} rest`)).toBe(base);
      expect(stripTrailingPunctuation(`${base}${char}`)).toBe(base);
    },
  );

  test("BMP 外の文字（約物でない）は両経路とも残す", () => {
    // U+20BB7（CJK 拡張 B の漢字）は Lo なので URL の構成要素として通る
    const url = `${base}/\u{20BB7}`;
    expect(detect(`${url} rest`)).toBe(url);
    expect(stripTrailingPunctuation(url)).toBe(url);
  });

  test("対応の取れた角括弧・波括弧も両経路とも残す", () => {
    for (const url of [`${base}/[a]`, `${base}/{a}`]) {
      expect(detect(`${url} rest`)).toBe(url);
      expect(stripTrailingPunctuation(url)).toBe(url);
    }
  });
});
