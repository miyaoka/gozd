/**
 * `linguist-languages` (= GitHub Linguist の languages.yml を JS 化したもの) と
 * Shiki の `bundledLanguagesInfo` を交差させて、拡張子 / ファイル名 → Shiki BundledLanguage
 * の静的マップを生成する。
 *
 * 実行: bun packages/shiki-lang-map/scripts/generateExtensionLangMap.ts
 * 設計詳細: packages/shiki-lang-map/README.md
 */

import fs from "node:fs";
import path from "node:path";
import type { BundledLanguage, BundledLanguageInfo } from "shiki";
import { bundledLanguagesInfo } from "shiki";
import * as linguist from "linguist-languages";

const SCRIPT_REL_PATH = "packages/shiki-lang-map/scripts/generateExtensionLangMap.ts";
const OUTPUT_FILE = path.resolve(import.meta.dir, "../dist/extensionLangMap.generated.ts");

/** Linguist name (lowercase) → Shiki id の **明示** マッピング。
 *
 * `resolveShikiId` の default rules (lowercase 一致 / 空白→hyphen / Linguist `aliases` 走査 /
 * Shiki alias fallback) で届かない pair だけを列挙する。default rules で resolve できる
 * entry を持ち込まない (検証ロジックが unused 警告を出す)。
 */
const NAME_TO_SHIKI: Record<string, BundledLanguage> = {
  "objective-c++": "objective-cpp",
  "visual basic .net": "vb",
  systemverilog: "system-verilog",
  // Linguist の git 系 / ignore list は専用 grammar が Shiki に無いため ini で代替する
  "git config": "ini",
  "git attributes": "ini",
  "git revision list": "ini",
  "ignore list": "ini",
  // Linguist の HTML+template 派生も Shiki に専用 grammar が無いため素 html に倒す
  "html+ecr": "html",
  "html+eex": "html",
  "html+php": "html",
};

const shikiIds = new Set<string>((bundledLanguagesInfo as readonly BundledLanguageInfo[]).map((l) => l.id));
// Shiki の alias (例: `"clj"` for `"clojure"`) も resolve できるので alias 集合も持つ
const shikiAliases = new Set<string>();
for (const info of bundledLanguagesInfo as readonly BundledLanguageInfo[]) {
  for (const a of info.aliases ?? []) shikiAliases.add(a);
}

interface LinguistLang {
  name: string;
  extensions?: readonly string[];
  filenames?: readonly string[];
  aliases?: readonly string[];
}

/** Linguist language entry から Shiki BundledLanguage id を解決する。
 *
 * Linguist の `name` と Shiki の `id` は必ずしも一致しない (例: Linguist
 * `"Protocol Buffer"` ↔ Shiki `"proto"`)。Linguist 側の `aliases` も走査することで
 * 表記揺れを吸収する。
 */
function resolveShikiId(lang: LinguistLang, usedExplicit: Set<string>): string | undefined {
  const name = lang.name.toLowerCase();

  // 1. 明示 alias table (一番強い)
  const explicit = NAME_TO_SHIKI[name];
  if (explicit !== undefined) {
    if (!shikiIds.has(explicit)) return undefined;
    usedExplicit.add(name);
    return explicit;
  }

  // 2. lowercase 直接一致
  if (shikiIds.has(name)) return name;

  // 3. 空白 → hyphen
  const hyphenated = name.replace(/\s+/g, "-");
  if (shikiIds.has(hyphenated)) return hyphenated;

  // 4. Linguist 側の aliases (例: "Protocol Buffer" の aliases に "proto" が居る) を
  //    Shiki id / Shiki alias と突合する
  for (const a of lang.aliases ?? []) {
    const al = a.toLowerCase();
    if (shikiIds.has(al)) return al;
    const ah = al.replace(/\s+/g, "-");
    if (shikiIds.has(ah)) return ah;
    if (shikiAliases.has(al)) return al;
    if (shikiAliases.has(ah)) return ah;
  }

  // 5. Shiki alias 経由 fallback
  if (shikiAliases.has(name)) return name;
  if (shikiAliases.has(hyphenated)) return hyphenated;

  return undefined;
}

interface CollisionRecord {
  ext: string;
  winner: { lang: string; shikiId: string };
  losers: { lang: string; shikiId: string }[];
}

const extMap: Record<string, string> = {};
const extOwners: Record<string, { lang: string; shikiId: string }> = {};
const extCollisions: Record<string, CollisionRecord> = {};
const filenameMap: Record<string, string> = {};
const usedExplicit = new Set<string>();

const allLangs = Object.values(linguist) as readonly LinguistLang[];
const sortedLangs = [...allLangs].sort((a, b) => a.name.localeCompare(b.name));

let matchedLangCount = 0;
let unmatchedLangCount = 0;

for (const lang of sortedLangs) {
  const shikiId = resolveShikiId(lang, usedExplicit);
  if (shikiId === undefined) {
    unmatchedLangCount++;
    continue;
  }
  matchedLangCount++;

  for (const ext of lang.extensions ?? []) {
    // ".swift" → "swift" / "..." (空文字含む) は skip
    const key = ext.replace(/^\./, "").toLowerCase();
    if (key === "") continue;
    if (!(key in extMap)) {
      extMap[key] = shikiId;
      extOwners[key] = { lang: lang.name, shikiId };
    } else if (extOwners[key]!.shikiId !== shikiId) {
      // 別 Shiki id への loser を collision として記録
      const winner = extOwners[key]!;
      if (!(key in extCollisions)) {
        extCollisions[key] = { ext: key, winner, losers: [] };
      }
      extCollisions[key]!.losers.push({ lang: lang.name, shikiId });
    }
  }

  for (const filename of lang.filenames ?? []) {
    if (!(filename in filenameMap)) filenameMap[filename] = shikiId;
  }
}

// NAME_TO_SHIKI の unused entry を検出する (default rules で resolve できる /
// Linguist にその name が存在しないものを除く規律)
const unusedExplicit: string[] = [];
for (const name of Object.keys(NAME_TO_SHIKI)) {
  if (!usedExplicit.has(name)) unusedExplicit.push(name);
}

// 出力: 拡張子は ASCII order でソート
const extEntries = Object.entries(extMap).sort(([a], [b]) => a.localeCompare(b));
const filenameEntries = Object.entries(filenameMap).sort(([a], [b]) => a.localeCompare(b));

function fmtEntry([key, value]: [string, string]): string {
  return `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`;
}

const content = `// Auto-generated by ${SCRIPT_REL_PATH} — do not edit.
// Data source: GitHub Linguist (via linguist-languages npm) × Shiki BundledLanguage.
// Run \`bun ${SCRIPT_REL_PATH}\` to regenerate.

import type { BundledLanguage } from "shiki";

/** 拡張子 → Shiki BundledLanguage の対応表 (Linguist 由来)。
 *
 * 型は \`Partial<Record<string, BundledLanguage>>\` として export し、未存在 key の lookup が
 * \`undefined\` を返すことを呼び出し側で型上扱えるようにする (\`as Record<...>\` キャスト不要)。
 * 値の妥当性は宣言時に \`satisfies Record<string, BundledLanguage>\` で literal を検証する。
 */
export const LINGUIST_EXTENSION_LANG_MAP: Readonly<Partial<Record<string, BundledLanguage>>> = {
${extEntries.map(fmtEntry).join("\n")}
} satisfies Readonly<Record<string, BundledLanguage>>;

/** ファイル名 (拡張子なし、例: \`Dockerfile\`) → Shiki BundledLanguage (Linguist 由来) */
export const LINGUIST_FILENAME_LANG_MAP: Readonly<Partial<Record<string, BundledLanguage>>> = {
${filenameEntries.map(fmtEntry).join("\n")}
} satisfies Readonly<Record<string, BundledLanguage>>;
`;

fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
fs.writeFileSync(OUTPUT_FILE, content);

const collisionCount = Object.keys(extCollisions).length;
console.log(
  `Generated ${path.relative(process.cwd(), OUTPUT_FILE)}: ` +
    `${extEntries.length} extensions, ${filenameEntries.length} filenames. ` +
    `Matched ${matchedLangCount} Linguist langs to Shiki bundle, ${unmatchedLangCount} unmatched.`,
);

if (collisionCount > 0) {
  console.log(
    `\nAmbiguous extensions: ${collisionCount} extensions collide across Shiki langs ` +
      `(first-write-wins by Linguist ASCII order). Override in consumer if intent differs:`,
  );
  const sortedCollisions = Object.values(extCollisions).sort((a, b) =>
    a.ext.localeCompare(b.ext),
  );
  for (const c of sortedCollisions) {
    const losers = c.losers.map((l) => `${l.lang}=${l.shikiId}`).join(", ");
    console.log(`  .${c.ext} → ${c.winner.shikiId} (${c.winner.lang}) [losers: ${losers}]`);
  }
}

if (unusedExplicit.length > 0) {
  console.warn(
    `\nUnused NAME_TO_SHIKI entries (Linguist name not present, or default rules already cover):`,
  );
  for (const name of unusedExplicit) console.warn(`  ${JSON.stringify(name)}`);
  process.exitCode = 1;
}
