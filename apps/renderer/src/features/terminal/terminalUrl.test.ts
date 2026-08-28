import { describe, expect, test } from "bun:test";
import { TERMINAL_URL_REGEX, TRAILING_EXCLUDED_ASCII, truncateToUrlEnd } from "./terminalUrl";

/** WebLinksAddon の LinkComputer と同じく g フラグを足して行全体を走査する */
const findUrls = (line: string): string[] => {
  const flags = TERMINAL_URL_REGEX.flags.includes("g")
    ? TERMINAL_URL_REGEX.flags
    : `${TERMINAL_URL_REGEX.flags}g`;
  return [...line.matchAll(new RegExp(TERMINAL_URL_REGEX.source, flags))].map(([match]) => match);
};

/** 自動検出が拾う範囲 */
const detect = (line: string): string | undefined => findUrls(line).at(0);

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

  test("sub-delims を含む URL を切らない", () => {
    expect(findUrls("https://groups.google.com/forum/#!topic/foo/bar を見る")).toEqual([
      "https://groups.google.com/forum/#!topic/foo/bar",
    ]);
    expect(findUrls("https://example.com/it's-here です")).toEqual([
      "https://example.com/it's-here",
    ]);
    expect(findUrls("https://example.com/a*b です")).toEqual(["https://example.com/a*b"]);
  });

  test("markdown 強調に囲まれた URL は末尾のアスタリスクを含めない", () => {
    expect(findUrls("**https://example.com/a** です")).toEqual(["https://example.com/a"]);
  });

  test("scheme の大小混在を検出する", () => {
    expect(findUrls("Https://example.com/a です")).toEqual(["Https://example.com/a"]);
    expect(findUrls("HTTPS://example.com/a です")).toEqual(["HTTPS://example.com/a"]);
  });

  test("1 行に複数の URL があればすべて検出する", () => {
    expect(findUrls("https://a.example.com/x と https://b.example.com/y")).toEqual([
      "https://a.example.com/x",
      "https://b.example.com/y",
    ]);
  });
});

describe("truncateToUrlEnd", () => {
  test("対応する開き括弧が無い閉じ括弧を落とす", () => {
    expect(truncateToUrlEnd("http://example.com)")).toBe("http://example.com");
  });

  test("対応する開き括弧がある閉じ括弧は残す", () => {
    expect(truncateToUrlEnd("https://en.wikipedia.org/wiki/Rust_(video_game)")).toBe(
      "https://en.wikipedia.org/wiki/Rust_(video_game)",
    );
  });

  test("括弧の後にパスが続く URL を壊さない", () => {
    expect(truncateToUrlEnd("https://example.com/a_(b)/c")).toBe("https://example.com/a_(b)/c");
  });

  test("角括弧と波括弧も同じ規則で扱う", () => {
    expect(truncateToUrlEnd("http://example.com]")).toBe("http://example.com");
    expect(truncateToUrlEnd("http://example.com/[a]")).toBe("http://example.com/[a]");
    expect(truncateToUrlEnd("http://example.com}")).toBe("http://example.com");
  });

  test("末尾の ASCII 約物を落とす", () => {
    expect(truncateToUrlEnd("http://example.com.")).toBe("http://example.com");
    expect(truncateToUrlEnd("http://example.com,")).toBe("http://example.com");
    expect(truncateToUrlEnd("http://example.com?")).toBe("http://example.com");
  });

  test("末尾の全角約物を落とす", () => {
    expect(truncateToUrlEnd("http://example.com）")).toBe("http://example.com");
    expect(truncateToUrlEnd("http://example.com。")).toBe("http://example.com");
  });

  test("連続した約物をまとめて落とす", () => {
    expect(truncateToUrlEnd("http://example.com).")).toBe("http://example.com");
  });

  test("全角括弧に囲われた文字列を丸ごと落とす", () => {
    // 剥がす方式では約物でない `5f1d686e5c5` で止まり、開き括弧より後ろが残る
    expect(truncateToUrlEnd("https://github.com/o/r/pull/18245（`5f1d686e5c5`）")).toBe(
      "https://github.com/o/r/pull/18245",
    );
  });

  test("URL の後ろに続く日本語の文を落とす", () => {
    expect(truncateToUrlEnd("https://example.com/a。次の文")).toBe("https://example.com/a");
  });

  test("URL に意味のある末尾文字は残す", () => {
    expect(truncateToUrlEnd("http://example.com/")).toBe("http://example.com/");
    expect(truncateToUrlEnd("http://example.com/a-b")).toBe("http://example.com/a-b");
    expect(truncateToUrlEnd("http://example.com/a_b")).toBe("http://example.com/a_b");
    expect(truncateToUrlEnd("http://example.com/#frag")).toBe("http://example.com/#frag");
    expect(truncateToUrlEnd("http://example.com/?a=1")).toBe("http://example.com/?a=1");
    expect(truncateToUrlEnd("http://example.com/%E6%97%A5")).toBe("http://example.com/%E6%97%A5");
  });

  test("パス末尾の日本語は残す", () => {
    expect(truncateToUrlEnd("https://example.com/日本語ページ")).toBe(
      "https://example.com/日本語ページ",
    );
  });

  test("URL として読めない scheme は素通しする", () => {
    expect(truncateToUrlEnd("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(truncateToUrlEnd("file:///a/b（c）")).toBe("file:///a/b（c）");
  });

  test("先頭が URL でない URI は素通しする", () => {
    expect(truncateToUrlEnd("see https://example.com/a")).toBe("see https://example.com/a");
  });

  test("空文字を受け取っても落ちない", () => {
    expect(truncateToUrlEnd("")).toBe("");
  });
});

describe("URL の終端は経路によらず一致する", () => {
  const base = "https://example.com/path";

  test.each([...TRAILING_EXCLUDED_ASCII])("末尾の %j は両経路とも落とす", (char) => {
    expect(detect(`${base}${char} rest`)).toBe(base);
    expect(truncateToUrlEnd(`${base}${char}`)).toBe(base);
  });

  test.each(["）", "。", "、", "」", "！", "？"])("末尾の全角 %s は両経路とも落とす", (char) => {
    expect(detect(`${base}${char}続き`)).toBe(base);
    expect(truncateToUrlEnd(`${base}${char}`)).toBe(base);
  });

  test.each(["/", "-", "_", "=", "&", "+", "%", "#", "$", "@"])(
    "末尾の %s は両経路とも残す",
    (char) => {
      expect(detect(`${base}${char} rest`)).toBe(`${base}${char}`);
      expect(truncateToUrlEnd(`${base}${char}`)).toBe(`${base}${char}`);
    },
  );

  test("対応の取れた括弧は両経路とも残す", () => {
    const url = "https://en.wikipedia.org/wiki/Rust_(video_game)";
    expect(detect(`${url} rest`)).toBe(url);
    expect(truncateToUrlEnd(url)).toBe(url);
  });

  test("対応の無い閉じ括弧は両経路とも落とす", () => {
    expect(detect(`(${base}) rest`)).toBe(base);
    expect(truncateToUrlEnd(`${base})`)).toBe(base);
  });

  test.each(["(", "[", "{"])("対応の無い開き括弧 %s も両経路とも落とす", (char) => {
    expect(detect(`${base}${char} rest`)).toBe(base);
    expect(truncateToUrlEnd(`${base}${char}`)).toBe(base);
  });

  test("全角括弧で囲われた文字列は両経路とも落とす", () => {
    const line = `${base}（\`5f1d686e5c5\`）`;
    expect(detect(line)).toBe(base);
    expect(truncateToUrlEnd(line)).toBe(base);
  });

  // 終端集合は \p{P} と \p{S} の 2 つからなる。BMP 外について両方を踏む
  test.each(["\u{1039F}", "\u{11047}", "\u{16E97}"])(
    "BMP 外の約物（\\p{P}）%s も両経路とも落とす",
    (char) => {
      expect(detect(`${base}${char} rest`)).toBe(base);
      expect(truncateToUrlEnd(`${base}${char}`)).toBe(base);
    },
  );

  test.each(["\u{1F600}", "\u{1F680}", "\u{1F676}"])(
    "BMP 外の記号（\\p{S}）%s も両経路とも落とす",
    (char) => {
      expect(detect(`${base}${char} rest`)).toBe(base);
      expect(truncateToUrlEnd(`${base}${char}`)).toBe(base);
    },
  );

  test("BMP 外の文字（約物でない）は両経路とも残す", () => {
    // U+20BB7（CJK 拡張 B の漢字）は Lo なので URL の構成要素として通る
    const url = `${base}/\u{20BB7}`;
    expect(detect(`${url} rest`)).toBe(url);
    expect(truncateToUrlEnd(url)).toBe(url);
  });

  test.each(["!", "'", "*"])("URL の内部の sub-delims %s は両経路とも残す", (char) => {
    const url = `${base}/a${char}b`;
    expect(detect(`${url} rest`)).toBe(url);
    expect(truncateToUrlEnd(url)).toBe(url);
  });

  test.each(["Https", "HTTPS", "hTTp"])("scheme %s は両経路とも扱う", (scheme) => {
    const url = `${scheme}://example.com/a`;
    expect(detect(`${url}（x）`)).toBe(url);
    expect(truncateToUrlEnd(`${url}（x）`)).toBe(url);
  });

  test("1 段の入れ子括弧は両経路とも残す", () => {
    for (const url of [`${base}/a_(b_(c))`, `${base}/[a[b]]`, `${base}/{a{b}}`]) {
      expect(detect(`${url} rest`)).toBe(url);
      expect(truncateToUrlEnd(url)).toBe(url);
    }
  });

  test("2 段以上の入れ子括弧は両経路とも扱わない", () => {
    // 正規表現は再帰を持たないため深さに上限がある。経路間で同じ位置に落ちることを固定する
    expect(detect(`${base}/(((a))) rest`)).toBe(`${base}/`);
    expect(truncateToUrlEnd(`${base}/(((a)))`)).toBe(`${base}/`);
  });

  test("対応の取れた角括弧・波括弧も両経路とも残す", () => {
    for (const url of [`${base}/[a]`, `${base}/{a}`]) {
      expect(detect(`${url} rest`)).toBe(url);
      expect(truncateToUrlEnd(url)).toBe(url);
    }
  });
});
