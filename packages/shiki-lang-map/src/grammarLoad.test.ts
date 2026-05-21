import { describe, expect, test } from "bun:test";
import type { BundledLanguage } from "shiki";
import { codeToHtml } from "shiki";
import { LINGUIST_EXTENSION_LANG_MAP, LINGUIST_FILENAME_LANG_MAP } from "./index";

/**
 * Linguist × Shiki 交差で生成された全 BundledLanguage 値が、実際に Shiki shorthand
 * `codeToHtml` で grammar load + tokenize を完走することを検証する smoke test。
 *
 * これは generator の型レベル保証 (`satisfies Record<string, BundledLanguage>`) の
 * runtime 補完。BundledLanguage 型は Shiki の id / alias 両方を含むが、alias 経由
 * load が正しく動くかは Shiki 内部の `resolveLangAlias` 実装に依存する。将来の
 * Shiki major bump で alias 解決経路が変わった場合に CI で検出する目的。
 *
 * `codeToHtml` は内部 singleton で grammar をキャッシュするため、208 件規模でも
 * 累計実行時間は数秒で収まる (1 grammar あたり dynamic import + parse 1 回のみ)。
 */

function collectUniqueLangs(
  ...maps: ReadonlyArray<Readonly<Partial<Record<string, BundledLanguage>>>>
): readonly BundledLanguage[] {
  const set = new Set<BundledLanguage>();
  for (const map of maps) {
    for (const v of Object.values(map)) {
      if (v !== undefined) set.add(v);
    }
  }
  return [...set].sort();
}

const uniqueLangs = collectUniqueLangs(LINGUIST_EXTENSION_LANG_MAP, LINGUIST_FILENAME_LANG_MAP);

describe("generated map: every BundledLanguage value loads via shiki codeToHtml", () => {
  test("has at least one language to verify", () => {
    expect(uniqueLangs.length).toBeGreaterThan(0);
  });

  for (const lang of uniqueLangs) {
    test(`lang="${lang}" loads grammar without throwing`, async () => {
      // 空文字を渡しても shorthand 内部の `getSingletonHighlighter({ langs: [lang] })`
      // 経路は走るため grammar load の検証として十分。
      const html = await codeToHtml("", { lang, theme: "github-dark" });
      expect(typeof html).toBe("string");
    });
  }
});
