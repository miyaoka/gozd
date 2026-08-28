import { describe, expect, test } from "bun:test";
import { createOsc8Normalizer } from "./normalizeOsc8";

const ESC = "\x1b";
const ST = `${ESC}\\`;
const BEL = "\x07";
/** OSC 8 の宣言を組み立てる */
const osc8 = (uri: string, terminator = ST) => `${ESC}]8;;${uri}${terminator}`;

describe("createOsc8Normalizer", () => {
  test("OSC 8 を含まない出力はそのまま通す", () => {
    const normalize = createOsc8Normalizer();
    expect(normalize("plain text\r\n")).toBe("plain text\r\n");
  });

  test("URI 末尾の約物を落とす", () => {
    const normalize = createOsc8Normalizer();
    expect(normalize(`${osc8("http://example.com)")}LINK${osc8("")}`)).toBe(
      `${osc8("http://example.com")}LINK${osc8("")}`,
    );
  });

  test("全角約物も落とす", () => {
    const normalize = createOsc8Normalizer();
    expect(normalize(osc8("https://example.com/a）"))).toBe(osc8("https://example.com/a"));
  });

  test("全角括弧で囲われた文字列を丸ごと落とす", () => {
    const normalize = createOsc8Normalizer();
    const uri = "https://github.com/o/r/pull/18245（`5f1d686e5c5`）";
    expect(normalize(`${ESC}]8;id=xyz;${uri}${BEL}`)).toBe(
      `${ESC}]8;id=xyz;https://github.com/o/r/pull/18245${BEL}`,
    );
  });

  test("URL として読めない scheme の URI は書き換えない", () => {
    const normalize = createOsc8Normalizer();
    const declaration = osc8("file:///a/b（c）");
    expect(normalize(declaration)).toBe(declaration);
  });

  test("正しい URI は書き換えない", () => {
    const normalize = createOsc8Normalizer();
    const declaration = osc8("https://en.wikipedia.org/wiki/Rust_(video_game)");
    expect(normalize(declaration)).toBe(declaration);
  });

  test("BEL 終端でも扱う", () => {
    const normalize = createOsc8Normalizer();
    expect(normalize(osc8("http://example.com)", BEL))).toBe(osc8("http://example.com", BEL));
  });

  test("params 付きの宣言は params を保つ", () => {
    const normalize = createOsc8Normalizer();
    expect(normalize(`${ESC}]8;id=xyz;http://example.com)${ST}`)).toBe(
      `${ESC}]8;id=xyz;http://example.com${ST}`,
    );
  });

  test("リンクの終了（URI 空）はそのまま通す", () => {
    const normalize = createOsc8Normalizer();
    expect(normalize(osc8(""))).toBe(osc8(""));
  });

  test("宣言を落とさないので、次の宣言が前のリンクを閉じる関係が保たれる", () => {
    const normalize = createOsc8Normalizer();
    // 明示終端を挟まず 2 本続けても、両方の宣言が出力に残る
    const input = `${osc8("https://a.example.com")}A${osc8("https://b.example.com)")}B`;
    const output = normalize(input);
    expect(output).toBe(`${osc8("https://a.example.com")}A${osc8("https://b.example.com")}B`);
  });

  describe("シーケンスの終端", () => {
    test("裸の ESC も終端として扱い、後続の表示テキストを削らない", () => {
      const normalize = createOsc8Normalizer();
      // 端末は ESC で OSC を終端する。SGR 以降は宣言の外側で、書き換えの対象にならない
      const input = `${ESC}]8;;http://example.com${ESC}[31mRED.${BEL}`;
      expect(normalize(input)).toBe(input);
    });

    test("裸の ESC 終端でも URI の書き直しは効く", () => {
      const normalize = createOsc8Normalizer();
      expect(normalize(`${ESC}]8;;http://example.com)${ESC}[0m`)).toBe(
        `${ESC}]8;;http://example.com${ESC}[0m`,
      );
    });

    test.each([
      ["C1 の ST", "\x9c"],
      ["CAN", "\x18"],
      ["SUB", "\x1a"],
    ])("%s も終端として扱う", (_label, terminator) => {
      const normalize = createOsc8Normalizer();
      expect(normalize(`${ESC}]8;;http://example.com)${terminator}rest`)).toBe(
        `${ESC}]8;;http://example.com${terminator}rest`,
      );
    });

    test("裸の ESC が次の宣言の開始でもある場合、両方の宣言が残る", () => {
      const normalize = createOsc8Normalizer();
      // 1 本目は終端を持たず、次の宣言の ESC がそのまま終端になる
      const input = `${ESC}]8;;http://a.example.com${ESC}]8;;http://b.example.com)${ST}B`;
      expect(normalize(input)).toBe(
        `${ESC}]8;;http://a.example.com${ESC}]8;;http://b.example.com${ST}B`,
      );
    });

    test("C1 の OSC で始まる宣言も書き直す", () => {
      const normalize = createOsc8Normalizer();
      expect(normalize(`\x9d8;;http://example.com)${ST}`)).toBe(`\x9d8;;http://example.com${ST}`);
    });
  });

  test("1 チャンクに複数の宣言があっても全部処理する", () => {
    const normalize = createOsc8Normalizer();
    const input = `${osc8("http://a.example.com)")}A${osc8("")}mid${osc8("http://b.example.com.")}B`;
    expect(normalize(input)).toBe(
      `${osc8("http://a.example.com")}A${osc8("")}mid${osc8("http://b.example.com")}B`,
    );
  });

  describe("チャンク跨ぎ", () => {
    test("シーケンス途中で分割されても繋いで処理する", () => {
      const normalize = createOsc8Normalizer();
      const first = normalize(`before${ESC}]8;;http://exam`);
      // 終端が未着なので宣言は保留され、手前だけが出る
      expect(first).toBe("before");
      expect(normalize(`ple.com)${ST}LINK`)).toBe(`${osc8("http://example.com")}LINK`);
    });

    test("終端の ESC と `\\` の間で分割されても扱う", () => {
      const normalize = createOsc8Normalizer();
      expect(normalize(`${ESC}]8;;http://example.com)${ESC}`)).toBe("");
      expect(normalize(`\\LINK`)).toBe(`${osc8("http://example.com")}LINK`);
    });

    test("開始マーカーの途中で分割されても素通ししない", () => {
      const normalize = createOsc8Normalizer();
      // `\x1b` / `\x1b]` / `\x1b]8` はマーカーの途中。判断を次のチャンクへ持ち越す
      expect(normalize(`text${ESC}`)).toBe("text");
      expect(normalize(`]8;;http://example.com)${ST}LINK`)).toBe(
        `${osc8("http://example.com")}LINK`,
      );
    });

    test.each([1, 2, 3])("開始マーカーを %i 文字目で切っても繋ぐ", (cut) => {
      const normalize = createOsc8Normalizer();
      const declaration = `${ESC}]8;;http://example.com)${ST}`;
      const first = normalize(declaration.slice(0, cut));
      const second = normalize(declaration.slice(cut));
      expect(first + second).toBe(osc8("http://example.com"));
    });

    test("保留が上限を超えたらそのまま流す", () => {
      const normalize = createOsc8Normalizer();
      const huge = `${ESC}]8;;http://example.com/${"a".repeat(9000)}`;
      expect(normalize(huge)).toBe(huge);
    });
  });
});
