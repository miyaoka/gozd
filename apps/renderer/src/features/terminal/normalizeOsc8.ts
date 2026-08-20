import { logEvent } from "../../shared/debug";
import { stripTrailingPunctuation } from "./stripTrailingPunctuation";

/** OSC 8 の開始。`ESC ] 8 ;` */
const OSC_8_START = "\x1b]8;";

/** シーケンスの終端。`ESC \` と BEL のどちらも使われる */
const ST_ESC = "\x1b\\";
const ST_BEL = "\x07";

/**
 * 未完のシーケンスを保持する上限。超えたらそのまま流す。
 *
 * 端末出力は untrusted で、終端の来ないシーケンスを無限に送れる。保持を打ち切っても
 * xterm 側のパーサが独自の上限で処理するため、表示は壊れない。
 */
const MAX_PENDING = 8192;

/**
 * 端末へ書き込む前に OSC 8 の宣言を正規化する関数を作る。
 *
 * OSC 8 は出力側が URI を宣言する契約だが、文中の URL を検出して OSC 8 化するプログラムは
 * 終端の判定を誤り、`http://example.com)` のように後続の約物を URI へ含めることがある。
 * 宣言された範囲はそのまま下線になるため、受け取ってから直す手段が無い
 * （`ILinkHandler` は範囲を受け取るだけで変えられない）。書き込む前に直す。
 *
 * **宣言を落とすのではなく書き直す。** xterm は新しい宣言が来たとき前のリンクを暗黙に閉じる
 * ため、宣言を握り潰すと閉じ損ね、後続のテキストが前の URL のリンクになる。
 *
 * PTY の出力は任意の境界で分割されるため、終端が未着のシーケンスは次のチャンクまで保持する。
 */
export function createOsc8Normalizer(): (chunk: string) => string {
  let pending = "";

  return (chunk: string): string => {
    const input = pending + chunk;
    pending = "";

    const result = normalize(input);
    if (result.pending.length > MAX_PENDING) return result.output + result.pending;

    pending = result.pending;
    return result.output;
  };
}

/** 正規化した出力と、終端が未着で持ち越す断片 */
function normalize(input: string): { output: string; pending: string } {
  let output = "";
  let cursor = 0;

  for (;;) {
    const start = input.indexOf(OSC_8_START, cursor);
    if (start === -1) return { output: output + input.slice(cursor), pending: "" };

    output += input.slice(cursor, start);

    const bounds = findTerminator(input, start + OSC_8_START.length);
    // 終端が未着。シーケンスの途中で切らず、次のチャンクと繋いでから処理する
    if (bounds === undefined) return { output, pending: input.slice(start) };

    output += rewriteDeclaration(
      input.slice(start, bounds.bodyEnd),
      input.slice(bounds.bodyEnd, bounds.end),
    );
    cursor = bounds.end;
  }
}

/** シーケンス終端の位置。`bodyEnd` は終端の開始、`end` は終端の直後 */
function findTerminator(input: string, from: number): { bodyEnd: number; end: number } | undefined {
  const esc = input.indexOf(ST_ESC, from);
  const bel = input.indexOf(ST_BEL, from);

  if (esc !== -1 && (bel === -1 || esc < bel)) return { bodyEnd: esc, end: esc + ST_ESC.length };
  if (bel !== -1) return { bodyEnd: bel, end: bel + ST_BEL.length };
  return undefined;
}

/** 宣言 1 つを、URI の終端が誤っていれば正しい終端へ書き直す */
function rewriteDeclaration(declaration: string, terminator: string): string {
  const body = declaration.slice(OSC_8_START.length);
  const separator = body.indexOf(";");
  // params と URI の区切りが無いものは OSC 8 の形を成していない。判断せずそのまま流す
  if (separator === -1) return declaration + terminator;

  const uri = body.slice(separator + 1);
  const corrected = stripTrailingPunctuation(uri);
  if (corrected === uri) return declaration + terminator;

  // 書き直しは出力側の宣言を gozd の判断で変える操作。誤判定したときに事後で辿れるよう残す
  logEvent("terminal-link", "osc8-rewritten", "", `${uri} -> ${corrected}`);
  return OSC_8_START + body.slice(0, separator + 1) + corrected + terminator;
}
