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

    test("保留が上限を超えたらそのまま流す", () => {
      const normalize = createOsc8Normalizer();
      const huge = `${ESC}]8;;http://example.com/${"a".repeat(9000)}`;
      expect(normalize(huge)).toBe(huge);
    });
  });
});
