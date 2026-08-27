/**
 * URL の終端をどこに置くかの定義。自動検出（terminalUrlRegex.ts）と OSC 8 の宣言判定
 * （stripTrailingPunctuation.ts）が同じ終端を見るための SSOT。
 *
 * 一方は正規表現の文字クラス、他方は文字ごとの述語として使うため、表現は違うが集合は同じ。
 * 片方だけを直すと、同じ URL が経路によって違う終端になる。
 *
 * 文字クラスは素の文字を並べず `regexSource.ts` で機械展開する。集合を変えたときに
 * エスケープ規則を意識せずに済ませるため。
 */

/** 非 ASCII の約物。`v` フラグの差集合で ASCII 側を落とす（`/` `-` `.` 等は URL に必要） */
export const NON_ASCII_PUNCTUATION_SOURCE = String.raw`[[\p{P}\p{S}]--[\x00-\x7F]]`;

/** 非 ASCII の約物 1 文字を判定する */
export const NON_ASCII_PUNCTUATION = new RegExp(NON_ASCII_PUNCTUATION_SOURCE, "v");

/**
 * URL の末尾に来られない ASCII 文字。括弧は含まない — 括弧が URL の一部かは相方の有無で
 * 決まり、文字単体では決まらないため。
 */
export const TRAILING_EXCLUDED_ASCII = new Set(String.raw`"':,.!?;|\^~` + "`" + String.raw`<>`);

/**
 * 括弧 → 対応する相方。開き / 閉じの両方向を持つ。
 *
 * 末尾の括弧が URL の一部かは、相方より多いかどうかで決まる。`…/Rust_(video_game)` の `)` は
 * 残り、`(https://example.com)` の `)` は落ちる。開き括弧も同じ規則で扱う。
 */
export const BRACKET_PARTNER: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
  "(": ")",
  "[": "]",
  "{": "}",
};

/** URL の内部に来られない ASCII 文字。空白は別途 `\s` で扱う */
export const INNER_EXCLUDED_ASCII = new Set(String.raw`"'!*(){}|\^<>` + "`");
