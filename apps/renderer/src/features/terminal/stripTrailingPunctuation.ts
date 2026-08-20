import { BRACKET_PARTNER, NON_ASCII_PUNCTUATION, TRAILING_EXCLUDED_ASCII } from "./urlBoundary";

/**
 * URL 末尾に紛れ込んだ約物を落とす。OSC 8 ハイパーリンクの URI が信頼できるかの判定に使う
 * （落とした結果が元と違えば、その宣言は範囲を誤っている）。
 *
 * OSC 8 は出力側が URI を宣言する契約だが、文中の URL を検出して OSC 8 化するプログラムは
 * 終端の判定を誤り、`http://example.com)` のように後続の約物を URI へ含めることがある。
 *
 * 括弧は対応が取れていないときだけ落とす。`…/Rust_(video_game)` のような括弧を含む URL は
 * RFC 3986 上も合法で、これを誤りと判定しない。判定は開き / 閉じで対称に行う。
 */
export function stripTrailingPunctuation(url: string): string {
  // 括弧の数は末尾を削っても変わらないため、先に 1 度だけ数える
  const counts = countBrackets(url);

  let end = url.length;
  while (end > 0) {
    const char = url[end - 1];
    if (!isStrippableEnd(char, counts)) break;
    if (char in BRACKET_PARTNER) counts.set(char, (counts.get(char) ?? 0) - 1);
    end--;
  }

  return url.slice(0, end);
}

/** 末尾 1 文字を URL の外側と判定できるか */
function isStrippableEnd(char: string, counts: ReadonlyMap<string, number>): boolean {
  const partner = BRACKET_PARTNER[char];
  // 相方より多い括弧は対応が取れていない＝ URL の外側のもの
  if (partner !== undefined) return (counts.get(partner) ?? 0) < (counts.get(char) ?? 0);
  return TRAILING_EXCLUDED_ASCII.has(char) || NON_ASCII_PUNCTUATION.test(char);
}

/** 括弧の出現回数を数える */
function countBrackets(url: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const char of url) {
    if (char in BRACKET_PARTNER) counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  return counts;
}
