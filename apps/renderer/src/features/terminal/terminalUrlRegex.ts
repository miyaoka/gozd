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

/** 非 ASCII の約物。`v` フラグの差集合で ASCII 側を落とす（`/` `-` `.` 等は URL に必要） */
const NON_ASCII_PUNCTUATION = String.raw`[[\p{P}\p{S}]--[\x00-\x7F]]`;

/** URL の内部に来られない文字 */
const EXCLUDED = String.raw`\s"'!*\(\)\{\}\|\\^<>\`` + NON_ASCII_PUNCTUATION;

/** URL の末尾に来られない文字。文末の約物と、URL を囲うのに使われる括弧を落とす */
const EXCLUDED_AT_END = String.raw`\s"':,.!?\{\}\|\\^~\[\]\`\(\)<>` + NON_ASCII_PUNCTUATION;

/** URL 内で開いて閉じた括弧の一区切り。入れ子は扱わない */
const BALANCED_PAREN = String.raw`\([^\s\(\)]*\)`;

export const TERMINAL_URL_REGEX = new RegExp(
  String.raw`(https?|HTTPS?):[\/]{2}` +
    String.raw`(?:[^${EXCLUDED}]|${BALANCED_PAREN})*` +
    String.raw`(?:${BALANCED_PAREN}|[^${EXCLUDED_AT_END}])`,
  "v",
);
