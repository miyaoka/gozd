import { LINGUIST_EXTENSION_LANG_MAP, LINGUIST_FILENAME_LANG_MAP } from "@gozd/shiki-lang-map";
import {
  type BundledLanguage,
  type ShikiTransformer,
  type ThemedToken,
  codeToHtml as shikiCodeToHtml,
  codeToTokens as shikiCodeToTokens,
} from "shiki";

/** プロジェクト固有の拡張子 override。
 *
 * Linguist のデフォルト挙動 (= ASCII order での first-write-wins) を上書きしたい場合に
 * 列挙する。各エントリには「なぜ Linguist と違う選択をするか」を理由付きで残す。
 *
 * 値型は `BundledLanguage | null`:
 *  - `BundledLanguage`: Linguist のマッピングを上書き
 *  - `null`: Linguist 由来のマッピングを **除去** し、`detectLang` を `undefined` で返す
 *    (= ハイライトしない / plain text fallback)。collision diagnostic で観察された
 *    意図しないマッピングを明示的に黙らせる経路
 */
const EXTENSION_OVERRIDES: Partial<Record<string, BundledLanguage | null>> = {
  // .m: Linguist は MATLAB を ASCII 順優先で `.m → matlab` に倒すが、gozd は MATLAB ファイルを
  // 扱わず、apps/native の Objective-C / C ブリッジが対象。
  m: "objective-c",
  // .php: Linguist で Hack が ASCII 先勝ちのため `.php → hack` に倒れるが、PHP ファイルは
  // 圧倒的に多数派。Shiki に `php` grammar が存在する。
  php: "php",
  // .sql: Linguist で PLSQL が ASCII 先勝ちのため `.sql → plsql` に倒れるが、PL/SQL は
  // Oracle 固有方言。一般的な SQL ファイルは `sql` grammar が妥当。
  sql: "sql",
  // .jsx: Linguist は JSX を JavaScript の拡張子として持つため `.jsx → javascript` に倒れる。
  // Shiki は `jsx` grammar (`source.js.jsx`) を独立して提供するので、JSX タグの色付けが効く
  // ように override する。
  jsx: "jsx",
};

/** プロジェクト固有のファイル名 override (現在は無し)。値型は EXTENSION_OVERRIDES と同形 */
const FILENAME_OVERRIDES: Partial<Record<string, BundledLanguage | null>> = {};

/** ファイル名から Shiki BundledLanguage を推定する。
 *
 * 解決順序:
 *   filename override → Linguist filename → extension override → Linguist extension
 *
 * Linguist 由来のテーブルは build 時 codegen (`@gozd/shiki-lang-map`) で生成される。
 * データ SSOT は GitHub Linguist の `languages.yml` (linguist-languages npm)。
 *
 * 拡張子経路は `fileName.lastIndexOf(".") > 0` の場合のみ実行する。これで以下を弾く:
 * - `Makefile` / `LICENSE` 等の no-ext ファイル: `lastIndexOf === -1`
 * - `.bashrc` / `.gitignore` 等の dotfile: `lastIndexOf === 0` (先頭の `.` のみ)
 * 弾かないと filename map miss → `split(".").pop()` がファイル名全体を ext として返し、
 * Linguist が将来短い ext (`license` / `readme` 等) を追加した場合に偶然 hit して
 * 黙って誤分類するリスクが残る。
 */
function detectLang(filePath: string): BundledLanguage | undefined {
  const fileName = filePath.split("/").pop() ?? "";

  const filenameOverride = FILENAME_OVERRIDES[fileName];
  if (filenameOverride === null) return undefined; // 明示除去
  const filenameMatch = filenameOverride ?? LINGUIST_FILENAME_LANG_MAP[fileName];
  if (filenameMatch !== undefined) return filenameMatch;

  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0) return undefined;
  const lc = fileName.slice(lastDot + 1).toLowerCase();
  if (lc === "") return undefined;

  const extOverride = EXTENSION_OVERRIDES[lc];
  if (extOverride === null) return undefined; // 明示除去
  return extOverride ?? LINGUIST_EXTENSION_LANG_MAP[lc];
}

/** コードをハイライトして HTML 文字列を返す。言語不明ならプレーンテキストを返す。
 *
 * `blameEnabled` が true のときだけ行頭に `<button data-line-no-btn>` を挿入し、
 * false のときは `<span class="_line-no-static">` を挿入する。button だと CSS で
 * cursor を消しても keyboard (Tab + Enter) で到達でき silent dead button になるため、
 * blame できない経路では DOM 要素自体を span に倒して focusable を奪う契約。
 *
 * Shiki の shorthand `codeToHtml` は内部で grammar を on-demand load する
 * (`createSingletonShorthands` 経路、`getSingletonHighlighter` で idempotent)。
 */
async function highlight(
  code: string,
  filePath: string,
  blameEnabled: boolean,
): Promise<string | undefined> {
  const lang = detectLang(filePath);
  if (!lang) return undefined;

  const lineNumberTransformer: ShikiTransformer = {
    line(node, line) {
      node.properties["data-line"] = line;
      // 行頭の line-no 要素はテキスト子を持たせず、表示は CSS `::before` +
      // `content: attr(data-line-no-btn)` (静的経路は `data-line-no-static`) で行う。
      // 行番号を DOM テキストにしないことで以下を両立する:
      //   - クリップボードに行番号が混入しない (`::before` の content は構造的にコピー対象外)。
      //     `user-select: none` だけだと WebKit が Cmd+A / 範囲跨ぎ等で取りこぼすことがあり、
      //     構造で保証するほうが堅い
      //   - Shiki 既定の「行間 \n テキストノード」をそのまま使っても、空行スパンの中に
      //     user-select: none なテキストが居ない状態になるので、空行の改行が選択範囲から
      //     落ちにくくなる (改行が消える本来のバグへの対処)
      if (blameEnabled) {
        node.children.unshift({
          type: "element",
          tagName: "button",
          properties: {
            type: "button",
            class: "_line-no-btn",
            "data-line-no-btn": line,
            "aria-label": `Line ${line}`,
          },
          children: [],
        });
      } else {
        node.children.unshift({
          type: "element",
          tagName: "span",
          properties: {
            class: "_line-no-static",
            "data-line-no-static": line,
            "aria-hidden": "true",
          },
          children: [],
        });
      }
    },
  };

  return shikiCodeToHtml(code, {
    lang,
    theme: "github-dark",
    transformers: [lineNumberTransformer],
  });
}

/** コードを行ごとのトークン配列に変換する。言語不明なら undefined を返す */
async function highlightTokens(
  code: string,
  filePath: string,
): Promise<ThemedToken[][] | undefined> {
  const lang = detectLang(filePath);
  if (!lang) return undefined;

  const { tokens } = await shikiCodeToTokens(code, {
    lang,
    theme: "github-dark",
  });
  return tokens;
}

export { highlight, highlightTokens };
export type { ThemedToken };
