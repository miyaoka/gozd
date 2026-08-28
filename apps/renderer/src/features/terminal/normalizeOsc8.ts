import { logEvent } from "../../shared/debug";
import { toRegExpSource } from "./regexSource";
import { truncateToUrlEnd } from "./terminalUrl";

/**
 * OSC 8 の開始。`ESC ]` と C1 の OSC（`0x9d`）の 2 形式がある。
 *
 * 境界の定義は端末側のパーサに合わせる。ずれると「gozd が 1 つのシーケンスだと思う範囲」と
 * 「端末がそう扱う範囲」が食い違い、表示テキストを書き換えたり正規化を素通ししたりする。
 */
const OSC_8_STARTS = ["\x1b]8;", "\x9d8;"];

/**
 * OSC を終端する文字。端末側のパーサが OSC 文字列状態から抜ける集合と同じ。
 *
 * `ESC` は後ろが `\` でなくても終端になる（別のシーケンスの開始として扱われる）。
 * CAN / SUB はシーケンスを破棄する終端だが、そこで切れる点は同じ。
 */
const OSC_TERMINATORS = ["\x1b", "\x07", "\x9c", "\x18", "\x1a"];

/**
 * 開始マーカーと終端を、それぞれ 1 パスで探すためのパターン。定義の配列から導出する。
 *
 * 候補ごとに `indexOf` を呼ぶと、出現しない候補のぶんだけ残りを走査する。この層は端末出力の
 * 全バイトを通り、gozd は OSC 8 の出力を促しているため、宣言が密な出力は想定の範囲にある。
 *
 * `lastIndex` は可変状態で、全ターミナルの正規化器がこの 2 つを共有する。呼び出しごとに
 * 代入し、代入から `exec` までの間に yield を挟まない — 挟むと別の走査位置が混ざる。
 */
const START_PATTERN = new RegExp(OSC_8_STARTS.map(toRegExpSource).join("|"), "gu");
const TERMINATOR_PATTERN = new RegExp(`[${OSC_TERMINATORS.map(toRegExpSource).join("")}]`, "gu");

/**
 * 未完のシーケンスを保持する上限。超えたらそのまま流す。
 *
 * 端末出力は untrusted で、終端の来ないシーケンスを無限に送れる。保持を打ち切っても
 * 端末側のパーサが独自の上限で処理するため、表示は壊れない。
 */
const MAX_PENDING = 8192;

/**
 * 端末へ書き込む前に OSC 8 の宣言を正規化する関数を作る。
 *
 * OSC 8 は出力側が URI を宣言する契約だが、文中の URL を検出して OSC 8 化するプログラムは
 * 終端の判定を誤り、`http://example.com）` のように後続の約物を URI へ含めることがある。
 * 宣言された範囲はそのまま下線になるため、受け取ってから直す手段が無い
 * （`ILinkHandler` は範囲を受け取るだけで変えられない）。書き込む前に直す。
 *
 * **宣言を落とすのではなく書き直す。** 端末は新しい宣言が来たとき前のリンクを暗黙に閉じる
 * ため、宣言を握り潰すと閉じ損ね、後続のテキストが前の URL のリンクになる。
 *
 * PTY の出力は任意の境界で分割される。開始マーカーの途中で切れた場合も終端が未着の場合も、
 * 次のチャンクと繋いでから判断する。
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

/** 正規化した出力と、判断を次のチャンクまで保留する断片 */
function normalize(input: string): { output: string; pending: string } {
  let output = "";
  let cursor = 0;

  for (;;) {
    const found = findStart(input, cursor);
    if (found === undefined) {
      // 開始マーカーの途中で終わっていれば、そこから先は次のチャンクと繋いで判断する
      const cut = Math.max(cursor, input.length - danglingStartLength(input));
      return { output: output + input.slice(cursor, cut), pending: input.slice(cut) };
    }

    output += input.slice(cursor, found.start);

    const bounds = findTerminator(input, found.start + found.marker.length);
    // 終端が未着。シーケンスの途中で切らず、次のチャンクと繋いでから処理する
    if (bounds === undefined) return { output, pending: input.slice(found.start) };

    output += rewriteDeclaration(
      input.slice(found.start, bounds.bodyEnd),
      found.marker,
      input.slice(bounds.bodyEnd, bounds.end),
    );
    cursor = bounds.end;
  }
}

/** `cursor` 以降で最初に現れる OSC 8 の開始 */
function findStart(input: string, cursor: number): { start: number; marker: string } | undefined {
  START_PATTERN.lastIndex = cursor;
  const match = START_PATTERN.exec(input);
  if (match === null) return undefined;
  return { start: match.index, marker: match[0] };
}

/** 末尾が開始マーカーの途中なら、その長さ。次のチャンクと繋ぐために保留する */
function danglingStartLength(input: string): number {
  for (const marker of OSC_8_STARTS) {
    for (let length = marker.length - 1; length > 0; length--) {
      if (input.endsWith(marker.slice(0, length))) return length;
    }
  }
  return 0;
}

/**
 * シーケンス終端の位置。`bodyEnd` は終端の開始、`end` は次に処理を再開する位置。
 *
 * 裸の `ESC` は終端であると同時に次のシーケンスの開始なので消費しない（`end === bodyEnd`）。
 * 終端が `ESC` で後続が未着のときは、`ESC \` の途中かもしれないため判断を保留する。
 */
function findTerminator(input: string, from: number): { bodyEnd: number; end: number } | undefined {
  TERMINATOR_PATTERN.lastIndex = from;
  const match = TERMINATOR_PATTERN.exec(input);
  if (match === null) return undefined;

  const bodyEnd = match.index;
  if (input[bodyEnd] !== "\x1b") return { bodyEnd, end: bodyEnd + 1 };

  const next = input[bodyEnd + 1];
  if (next === undefined) return undefined;
  return { bodyEnd, end: next === "\\" ? bodyEnd + 2 : bodyEnd };
}

/** 宣言 1 つを、URI の終端が誤っていれば正しい終端へ書き直す */
function rewriteDeclaration(declaration: string, marker: string, terminator: string): string {
  const body = declaration.slice(marker.length);
  const separator = body.indexOf(";");
  // params と URI の区切りが無いものは OSC 8 の形を成していない。判断せずそのまま流す
  if (separator === -1) return declaration + terminator;

  const uri = body.slice(separator + 1);
  const corrected = truncateToUrlEnd(uri);
  if (corrected === uri) return declaration + terminator;

  // 書き直しは出力側の宣言を gozd の判断で変える操作。誤判定したときに事後で辿れるよう残す
  logEvent("terminal-link", "osc8-rewritten", "", `${uri} -> ${corrected}`);
  return marker + body.slice(0, separator + 1) + corrected + terminator;
}
