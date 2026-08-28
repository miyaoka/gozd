import { toRegExpSource } from "./regexSource";

/**
 * ターミナル出力に現れる URL の範囲を決める。
 *
 * 範囲を決める経路は 2 つある。テキストから URL を自動検出する経路（`WebLinksAddon` の
 * `urlRegex`）と、OSC 8 で宣言された URI を検査する経路。**両方が同じ 1 つの正規表現を見る。**
 * 判定を別々の実装で持つと、同じ URL が経路によって違う終端になる。
 *
 * addon の既定値は除外文字を ASCII の記号だけで列挙するため、全角約物や日本語が URL の一部と
 * して飲み込まれる。VS Code / kitty / linkify-it と同じく、非 ASCII の約物（Unicode の
 * punctuation / symbol）を終端文字として扱う。
 *
 * CJK の文字そのものは URL の構成要素として通す。パスに生の日本語を含む URL が実在し、
 * 除外すると `https://example.com/` までで切れた誤ったリンクが残るため。
 *
 * 括弧は URL を囲うのにも使われるため既定では終端だが、URL 内で開いて閉じた一区切りだけは
 * 構成要素として通す。`(` `)` は RFC 3986 の sub-delims で path に合法であり、
 * `…/Rust_(video_game)` を `…/Rust_` で切ると別のページが開いて誤りに気づけない。
 */

/** 非 ASCII の約物。`v` フラグの差集合で ASCII 側を落とす（`/` `-` `.` 等は URL に必要） */
const NON_ASCII_PUNCTUATION_SOURCE = String.raw`[[\p{P}\p{S}]--[\x00-\x7F]]`;

/**
 * URL の末尾に来られない ASCII 文字。括弧は含まない — 括弧が URL の一部かは相方の有無で
 * 決まり、文字単体では決まらないため。
 */
export const TRAILING_EXCLUDED_ASCII = new Set(String.raw`"':,.!?;|\^~*` + "`" + String.raw`<>`);

/**
 * URL の内部に来られない ASCII 文字。空白は別途 `\s` で扱う。
 *
 * 置く根拠は 2 つある。RFC 3986 が URI 文字として認めない記号と、仕様上は合法だが相方の
 * 有無でしか URL の一部かを判定できない括弧。括弧は対応の取れた一区切りだけを
 * `BALANCED_BRACKET` が通すため、単体ではここで落とす。
 *
 * sub-delims の `!` `'` `*` は path に合法なので通す（`…/forum/#!topic/x` を `…/forum/#` で
 * 切ると、404 にならず別のページへ着地して誤りに気づけない）。
 */
const INNER_EXCLUDED_ASCII = new Set(String.raw`"(){}|\^<>` + "`");

/** URL の内部に来られない文字。空白と、URL を囲う / シェルで意味を持つ記号 */
const EXCLUDED =
  String.raw`\s` +
  toRegExpSource(INNER_EXCLUDED_ASCII) +
  toRegExpSource("[]") +
  NON_ASCII_PUNCTUATION_SOURCE;

/** URL の末尾に来られない文字。終端の集合に、対応の取れない括弧と空白を足す */
const EXCLUDED_AT_END =
  String.raw`\s` +
  toRegExpSource(TRAILING_EXCLUDED_ASCII) +
  toRegExpSource("()[]{}") +
  NON_ASCII_PUNCTUATION_SOURCE;

/**
 * URL 内で開いて閉じた括弧の一区切り。入れ子は 1 段まで扱う。
 *
 * 3 種すべてを扱うのは、括弧の判定を経路間で揃えるため。角括弧は IPv6 リテラル
 * `http://[::1]/` でも現れる。
 *
 * 深さに上限を置くのは、正規表現が再帰を持たないため。
 */
const balancedBracket = (open: string, close: string): string => {
  const [openSource, closeSource] = [toRegExpSource(open), toRegExpSource(close)];
  const inner = `[^${String.raw`\s`}${openSource}${closeSource}]`;
  return `${openSource}(?:${inner}|${openSource}${inner}*${closeSource})*${closeSource}`;
};

const BALANCED_BRACKET = [
  balancedBracket("(", ")"),
  balancedBracket("[", "]"),
  balancedBracket("{", "}"),
].join("|");

/**
 * scheme の綴り。大小を問わず受ける。
 *
 * `i` フラグを足す方法を採らないのは、`v` モードの否定文字クラスが `i` の下で
 * case folding の制約を受けるため。scheme 側だけを文字クラスで書けば影響が閉じる。
 */
const SCHEME = String.raw`[hH][tT][tT][pP][sS]?`;

/** ターミナル出力中の URL を検出する正規表現。`WebLinksAddon` の `urlRegex` に渡す */
export const TERMINAL_URL_REGEX = new RegExp(
  String.raw`${SCHEME}:[\/]{2}` +
    String.raw`(?:[^${EXCLUDED}]|${BALANCED_BRACKET})*` +
    String.raw`(?:${BALANCED_BRACKET}|[^${EXCLUDED_AT_END}])`,
  "v",
);

/**
 * OSC 8 で宣言された URI を URL の終端で切り詰める。宣言が範囲を誤っているかの判定に使う
 * （切り詰めた結果が元と違えば、その宣言は範囲を誤っている）。
 *
 * OSC 8 は出力側が URI を宣言する契約だが、文中の URL を検出して OSC 8 化するプログラムは
 * 終端の判定を誤り、`http://example.com）` のように後続の約物を URI へ含めることがある。
 *
 * **判定は末尾から約物を剥がすのではなく、先頭から URL として読める範囲を採る。** 剥がす
 * 方式は約物でない文字に当たると停止するため、`https://example.com/a（補足）` のように
 * 約物が中身を挟む形の宣言から、開き括弧より後ろを落としきれない。
 *
 * URL として読めない URI（`mailto:` や `file:` 等）と、先頭が URL でない URI は判断の対象外
 * として素通しする。
 */
export function truncateToUrlEnd(uri: string): string {
  const match = TERMINAL_URL_REGEX.exec(uri);
  if (match === null || match.index !== 0) return uri;
  return match[0];
}
