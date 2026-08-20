import type { IBuffer, IBufferLine } from "@xterm/xterm";
import { PATH_TERMINATORS } from "./findAbsolutePathMatches";

/**
 * 現在行から上下それぞれ何行まで結合を試すか。
 *
 * 候補数は `(MAX_SPAN + 1)^2` で効き、そのまま実在確認の問い合わせ件数に乗る。増やすときは
 * 二次で増えることを前提に判断する。この行数を超えて折り返されたパスは検出されない。
 */
const MAX_SPAN = 4;

/** 1 つの結合結果 */
export interface JoinedText {
  text: string;
  /** 結合テキスト中で現在行の中身が始まる string 位置 */
  currentLineOffset: number;
  /**
   * 現在行から落とした先頭の空白数。インデント継続として連結したときだけ 0 より大きい。
   *
   * リンクの範囲は最終的に raw 行のセル座標へ変換されるため、結合テキスト上の index を
   * raw 行の index に戻すのにこの幅が要る。
   */
  currentLineTrimmed: number;
}

/** 継続行の連結方法。null は継続でない */
type Continuation = "raw" | "trimStart";

/**
 * 現在行を含む連続行の結合を、範囲を変えて列挙する。
 *
 * 長いパスは複数行に分かれて出力される。折り返しの形は、ターミナルが折り返した場合
 * （`isWrapped` が立つ）、出力側が改行だけを書いた場合、出力側が改行とインデントを書いた
 * 場合の 3 つで、後ろ 2 つはバッファに印が残らない（折り返し幅は出力時の端末幅で決まり、
 * その後のリサイズで痕跡が消える）。
 *
 * そのため**どこから始まりどこで終わるかを決めず、ありうる範囲をすべて候補にする**。
 * 結合しなかった場合（現在行のみ）も範囲の 1 つとして含む。選別は呼び出し側の実在確認が行う。
 *
 * 範囲を全部試すのは、隣接する別々のパスが繋がってしまうため。パス文字が続く限り結合すると
 * `/tmp/a.txt` と `/tmp/b.txt` が 1 つになり、正しい範囲が候補から漏れる。
 */
export function collectJoinCandidates(buf: IBuffer, lineIdx: number): JoinedText[] {
  // 隣接行の繋ぎ方を先に確定させる。joinRange は結果を引くだけで判定を繰り返さない
  // （結合条件と位置計算を二重管理すると乖離する）
  const joinModes = new Map<number, Continuation>();

  let top = lineIdx;
  for (let idx = lineIdx; idx > 0 && lineIdx - idx < MAX_SPAN; idx--) {
    const mode = continuationAt(buf, idx);
    if (mode === null) break;
    joinModes.set(idx, mode);
    top = idx - 1;
  }

  let bottom = lineIdx;
  for (let idx = lineIdx + 1; idx - lineIdx <= MAX_SPAN; idx++) {
    const mode = continuationAt(buf, idx);
    if (mode === null) break;
    joinModes.set(idx, mode);
    bottom = idx;
  }

  const results: JoinedText[] = [];
  for (let rangeTop = top; rangeTop <= lineIdx; rangeTop++) {
    for (let rangeBottom = lineIdx; rangeBottom <= bottom; rangeBottom++) {
      results.push(joinRange(buf, rangeTop, rangeBottom, lineIdx, joinModes));
    }
  }
  return results;
}

/** `idx - 1` から `idx` への繋ぎ方。どちらかの行が無ければ継続でない */
function continuationAt(buf: IBuffer, idx: number): Continuation | null {
  const line = buf.getLine(idx);
  const prev = buf.getLine(idx - 1);
  if (!line || !prev) return null;
  return continuationOf(prev, line);
}

/** [top, bottom] の行を結合し、現在行の開始オフセットとともに返す */
function joinRange(
  buf: IBuffer,
  top: number,
  bottom: number,
  lineIdx: number,
  joinModes: ReadonlyMap<number, Continuation>,
): JoinedText {
  let text = "";
  let currentLineOffset = 0;
  let currentLineTrimmed = 0;

  for (let idx = top; idx <= bottom; idx++) {
    const line = buf.getLine(idx);
    if (!line) break;

    const lineText = line.translateToString(true);
    const joined =
      idx !== top && joinModes.get(idx) === "trimStart" ? lineText.trimStart() : lineText;

    if (idx === lineIdx) {
      currentLineOffset = text.length;
      currentLineTrimmed = lineText.length - joined.length;
    }
    text += joined;
  }

  return { text, currentLineOffset, currentLineTrimmed };
}

/**
 * line が prev の継続行かを判定し、連結方法を返す。
 *
 * パスが途中で切れているなら、前の行はパス文字で終わり、次の行はパス文字で始まる。
 * これは折り返しの必要条件でしかなく、無関係な 2 行が偶然満たすこともある。
 * 十分条件まで詰めずに済むのは、結合範囲を複数試し実在確認で選別するため。
 */
function continuationOf(prev: IBufferLine, line: IBufferLine): Continuation | null {
  if (line.isWrapped) return "raw";

  const text = line.translateToString(true);
  if (!endsInPathChar(prev)) return null;
  if (!startsWithTerminator(text)) return "raw";

  // インデント継続。空白は区切り文字なので上の raw 判定では拾われない
  if (text[0] === " " && !startsWithTerminator(text.trimStart())) return "trimStart";
  return null;
}

/** 行末がパス文字で終わっているか（＝パスが途中で切れうる形か） */
function endsInPathChar(line: IBufferLine): boolean {
  const last = line.translateToString(true).at(-1);
  if (last === undefined) return false;
  return !PATH_TERMINATORS.test(last);
}

/** 先頭が区切り文字か（`# comment` のような別トークンを除外する） */
function startsWithTerminator(text: string): boolean {
  const head = text[0];
  if (head === undefined) return true;
  return PATH_TERMINATORS.test(head);
}
