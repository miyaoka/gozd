import {
  INNER_EXCLUDED_ASCII,
  NON_ASCII_PUNCTUATION_SOURCE,
  TRAILING_EXCLUDED_ASCII,
  toClassSource,
} from "./urlBoundary";

/**
 * ターミナル出力中の URL を検出する正規表現。`WebLinksAddon` の `urlRegex` に渡す。
 *
 * addon の既定値は除外文字を ASCII の記号だけで列挙するため、全角約物や日本語が
 * URL の一部として飲み込まれる。VS Code / kitty / linkify-it と同じく、非 ASCII の
 * 約物（Unicode の punctuation / symbol）を終端文字として扱う。
 *
 * CJK の文字そのものは URL の構成要素として通す。パスに生の日本語を含む URL が実在し、
 * 除外すると `https://example.com/` までで切れた誤ったリンクが残るため。
 *
 * 括弧は URL を囲うのにも使われるため既定では終端だが、URL 内で開いて閉じた一区切りだけは
 * 構成要素として通す。`(` `)` は RFC 3986 の sub-delims で path に合法であり、
 * `…/Rust_(video_game)` を `…/Rust_` で切ると別のページが開いて誤りに気づけない。
 */

/** URL の内部に来られない文字。空白と、URL を囲う / シェルで意味を持つ記号 */
const EXCLUDED =
  String.raw`\s` +
  toClassSource(INNER_EXCLUDED_ASCII) +
  toClassSource("[]") +
  NON_ASCII_PUNCTUATION_SOURCE;

/** URL の末尾に来られない文字。終端の集合に、対応の取れない括弧と空白を足す */
const EXCLUDED_AT_END =
  String.raw`\s` +
  toClassSource(TRAILING_EXCLUDED_ASCII) +
  toClassSource("()[]{}") +
  NON_ASCII_PUNCTUATION_SOURCE;

/**
 * URL 内で開いて閉じた括弧の一区切り。入れ子は扱わない。
 *
 * 3 種すべてを扱うのは、括弧の判定を経路間で揃えるため（`urlBoundary.ts`）。角括弧は
 * IPv6 リテラル `http://[::1]/` でも現れる。
 */
const BALANCED_BRACKET = [
  String.raw`\([^\s\(\)]*\)`,
  String.raw`\[[^\s\[\]]*\]`,
  String.raw`\{[^\s\{\}]*\}`,
].join("|");

export const TERMINAL_URL_REGEX = new RegExp(
  String.raw`(https?|HTTPS?):[\/]{2}` +
    String.raw`(?:[^${EXCLUDED}]|${BALANCED_BRACKET})*` +
    String.raw`(?:${BALANCED_BRACKET}|[^${EXCLUDED_AT_END}])`,
  "v",
);
