import type { IBuffer, IBufferLine } from "@xterm/xterm";
import { PATH_TERMINATORS } from "./findAbsolutePathMatches";

/** 現在行から上下それぞれ何行まで結合を試すか */
const MAX_SPAN = 4;

/** 1 つの結合結果 */
export interface JoinedText {
  text: string;
  /** 結合テキスト中で現在行が始まる string 位置 */
  currentLineOffset: number;
}

/**
 * 現在行を含む連続行の結合を、範囲を変えて列挙する。
 *
 * 長いパスは複数行に分かれて出力される。ターミナルが折り返せば `isWrapped` が立つが、
 * 出力側が自前で折り返して改行を書く場合は何も立たず、形状からも判別できない
 * （折り返し幅は出力時の端末幅で決まり、その後のリサイズで痕跡が消える）。
 *
 * そのため**どこから始まりどこで終わるかを決めず、ありうる範囲をすべて候補にする**。
 * 結合しなかった場合（現在行のみ）も範囲の 1 つとして含む。選別は呼び出し側の実在検証が行う。
 *
 * 範囲を全部試すのは、隣接する別々のパスが繋がってしまうため。パス文字が続く限り結合すると
 * `/tmp/a.txt` と `/tmp/b.txt` が 1 つになり、正しい範囲が候補から漏れる。
 */
export function collectJoinCandidates(buf: IBuffer, lineIdx: number): JoinedText[] {
  const topCandidates = reachableTops(buf, lineIdx);
  const bottomCandidates = reachableBottoms(buf, lineIdx);

  const results: JoinedText[] = [];
  for (const top of topCandidates) {
    for (const bottom of bottomCandidates) {
      results.push(joinRange(buf, top, bottom, lineIdx));
    }
  }
  return results;
}

/** 現在行から上へ、継続条件を満たす限り遡った行番号（現在行自身を含む） */
function reachableTops(buf: IBuffer, lineIdx: number): number[] {
  const tops = [lineIdx];
  for (let i = lineIdx; i > 0 && lineIdx - i < MAX_SPAN; i--) {
    const line = buf.getLine(i);
    const prev = buf.getLine(i - 1);
    if (!line || !prev || continuationOf(prev, line) === null) break;
    tops.push(i - 1);
  }
  return tops;
}

/** 現在行から下へ、継続条件を満たす限り辿った行番号（現在行自身を含む） */
function reachableBottoms(buf: IBuffer, lineIdx: number): number[] {
  const bottoms = [lineIdx];
  for (let i = lineIdx; i - lineIdx < MAX_SPAN; i++) {
    const line = buf.getLine(i);
    const next = buf.getLine(i + 1);
    if (!line || !next || continuationOf(line, next) === null) break;
    bottoms.push(i + 1);
  }
  return bottoms;
}

/** [top, bottom] の行を結合し、現在行の開始オフセットとともに返す */
function joinRange(buf: IBuffer, top: number, bottom: number, lineIdx: number): JoinedText {
  let text = "";
  let currentLineOffset = 0;

  for (let idx = top; idx <= bottom; idx++) {
    const line = buf.getLine(idx);
    if (!line) break;
    if (idx === lineIdx) currentLineOffset = text.length;

    if (idx === top) {
      text += line.translateToString(true);
      continue;
    }
    const prev = buf.getLine(idx - 1);
    const mode = prev ? continuationOf(prev, line) : null;
    if (mode === null) break;
    const lineText = line.translateToString(true);
    text += mode === "raw" ? lineText : lineText.trimStart();
  }

  return { text, currentLineOffset };
}

/** 継続行の連結方法。null は継続でない */
type Continuation = "raw" | "trimStart" | null;

/**
 * line が prev の継続行かを判定し、連結方法を返す。
 *
 * パスが途中で切れているなら、前の行はパス文字で終わり、次の行はパス文字で始まる。
 * これは折り返しの必要条件でしかなく、無関係な 2 行が偶然満たすこともある。
 * 十分条件まで詰めずに済むのは、結合範囲を複数試し実在検証で選別するため。
 */
function continuationOf(prev: IBufferLine, line: IBufferLine): Continuation {
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
