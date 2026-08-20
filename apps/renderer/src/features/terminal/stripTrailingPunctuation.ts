/**
 * URL 末尾に紛れ込んだ約物を落とす。OSC 8 ハイパーリンクの URI に適用する。
 *
 * OSC 8 は出力側が URI を宣言する契約だが、文中の URL を検出して OSC 8 化するプログラムは
 * 終端の判定を誤り、`http://example.com)` のように後続の約物を URI へ含めることがある。
 * 宣言をそのまま開くと存在しない URL に飛ぶため、開く直前に落とす。
 *
 * 閉じ括弧は URL 内に対応する開き括弧が無いときだけ落とす。`…/Rust_(video_game)` のような
 * 括弧を含む URL は RFC 3986 上も合法で、これを壊さない。
 */

/** 閉じ括弧 → 対応する開き括弧 */
const CLOSING_TO_OPENING: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
};

/** URL の末尾に意味を持たない ASCII 約物 */
const STRIPPABLE_ASCII = new Set([".", ",", ";", ":", "!", "?", "'", '"']);

/** 非 ASCII の約物。全角括弧や句読点が該当する */
const NON_ASCII_PUNCTUATION = /[[\p{P}\p{S}]--[\x00-\x7F]]/v;

const countChar = (text: string, char: string): number =>
  [...text].filter((c) => c === char).length;

/** 末尾 1 文字が URL の一部でないと判定できるか */
const isStrippable = (url: string, char: string): boolean => {
  const opening = CLOSING_TO_OPENING[char];
  // 対応する開き括弧より閉じ括弧が多いなら、その閉じ括弧は URL の外側のもの
  if (opening !== undefined) return countChar(url, opening) < countChar(url, char);
  if (STRIPPABLE_ASCII.has(char)) return true;
  return NON_ASCII_PUNCTUATION.test(char);
};

export function stripTrailingPunctuation(url: string): string {
  const last = url.at(-1);
  if (last === undefined) return url;
  if (!isStrippable(url, last)) return url;
  return stripTrailingPunctuation(url.slice(0, -1));
}
