import { LINGUIST_EXTENSION_LANG_MAP, LINGUIST_FILENAME_LANG_MAP } from "@gozd/shiki-lang-map";
import { type BundledLanguage, type ThemedToken, codeToTokens as shikiCodeToTokens } from "shiki";

/** preview 系 (CodePreview の Monaco 統合 / DiffPreview のトークン化) で共有する Shiki テーマ */
const SHIKI_THEME = "github-dark";

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
  // 扱わず、閲覧対象は Objective-C / C ソースが主。
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

/** コードを行ごとのトークン配列に変換する。言語不明なら undefined を返す */
async function highlightTokens(
  code: string,
  filePath: string,
): Promise<ThemedToken[][] | undefined> {
  const lang = detectLang(filePath);
  if (!lang) return undefined;

  const { tokens } = await shikiCodeToTokens(code, {
    lang,
    theme: SHIKI_THEME,
  });
  return tokens;
}

export { detectLang, highlightTokens, SHIKI_THEME };
export type { ThemedToken };
