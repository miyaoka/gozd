/**
 * 行内 (文字単位) diff の計算と segment 分割。
 *
 * 行単位 diff の SSOT は git (`rpcGitDiffHunks`) のまま動かさず、ここは「git が変更と
 * 判定したブロック (removed run × added run) の内側」だけを対象にする表示専用レイヤー。
 *
 * アルゴリズムは自前実装せず、monaco-editor の ESM 内部モジュールから VSCode の
 * `DefaultLinesDiffComputer` を deep import する。monaco の ESM 配布物は 1 モジュール
 * 1 ファイルで、`vs/editor/common/diff/` 配下はエディタ UI / 言語サービスを含まない
 * DOM 非依存の純計算部なので、編集モード (monacoSetup.ts の遅延ロード) とは独立に
 * 静的 import してよい。これにより VSCode diff editor と同一の行内アライメントと
 * ノイズ抑制ヒューリスティック (単語境界への拡張、細切れ一致の除去、境界シフト) が
 * そのまま得られる。
 */
import { DefaultLinesDiffComputer } from "monaco-editor/esm/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js";

/** 1 行内の変更範囲。VSCode の Range と同じく column は 1-based / end-exclusive。 */
export interface ColRange {
  start: number;
  end: number;
}

/**
 * removed run × added run の行内 diff 結果。
 * key はそれぞれ oldLines / newLines への 0-based index。
 */
export interface IntraLineRanges {
  old: Map<number, ColRange[]>;
  new: Map<number, ColRange[]>;
}

/** stateless (呼び出し間で状態を持たない) なので module singleton で使い回す */
const linesDiffComputer = new DefaultLinesDiffComputer();

/**
 * 変更ブロック (removed 行群 vs added 行群) の行内変更範囲を計算する。
 *
 * ブロック全体を 1 つのミニ文書ペアとして `computeDiff` に渡す。VSCode 本体と同じく
 * ブロック内の行アライメント (N 行 vs M 行の対応づけ) も computeDiff 側に委ねるため、
 * 呼び出し側の貪欲ペアリング (split view の行配置) とは独立に、行またぎの文字対応が取れる。
 *
 * `maxTimeMs` 超過で打ち切られた場合 (`hitTimeout`) は undefined を返し、そのブロックは
 * 行内ハイライトなし (行単位の背景のみ) に degrade する。VSCode も同じ degrade 戦略を取る。
 */
export function computeIntraLineRanges(
  oldLines: string[],
  newLines: string[],
  maxTimeMs: number,
): IntraLineRanges | undefined {
  const result = linesDiffComputer.computeDiff(oldLines, newLines, {
    ignoreTrimWhitespace: false,
    maxComputationTimeMs: maxTimeMs,
    computeMoves: false,
  });
  if (result.hitTimeout) return undefined;

  const old = new Map<number, ColRange[]>();
  const next = new Map<number, ColRange[]>();
  for (const change of result.changes) {
    if (!change.innerChanges) continue;
    for (const mapping of change.innerChanges) {
      pushRangePerLine(mapping.originalRange, oldLines, old);
      pushRangePerLine(mapping.modifiedRange, newLines, next);
    }
  }
  return { old, new: next };
}

/**
 * 複数行にまたがりうる Range を行ごとの ColRange に分解して out に積む。
 * 行末の改行を含む range は当該行の末尾 (`length + 1`) にクランプされる。
 * 幅 0 の range (片側だけの挿入 / 削除でもう片側に対応幅が無いケース) は描画対象が
 * 無いので捨てる。
 */
function pushRangePerLine(
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  },
  lines: string[],
  out: Map<number, ColRange[]>,
): void {
  for (let ln = range.startLineNumber; ln <= range.endLineNumber; ln++) {
    const text = lines[ln - 1];
    // range はミニ文書内に閉じる (computeDiff の出力契約) ため、行が引けなければ
    // 上流の invariant 違反。silent に捨てず throw して呼び出し側の error 経路に乗せる。
    if (text === undefined) {
      throw new Error(
        `intra-line range out of block: line=${ln} blockLines=${lines.length} ` +
          `range=${range.startLineNumber}:${range.startColumn}-${range.endLineNumber}:${range.endColumn}`,
      );
    }
    const start = ln === range.startLineNumber ? range.startColumn : 1;
    const end =
      ln === range.endLineNumber ? Math.min(range.endColumn, text.length + 1) : text.length + 1;
    if (end <= start) continue;
    const key = ln - 1;
    const list = out.get(key);
    if (list) {
      list.push({ start, end });
    } else {
      out.set(key, [{ start, end }]);
    }
  }
}

/** splitSegments の出力。1 span に対応する。 */
export interface LineSegment {
  text: string;
  color?: string;
  marked: boolean;
}

/**
 * 1 行分のテキストを「Shiki トークン境界」と「行内変更範囲境界」の両方で切った
 * segment 列に分割する。segment ごとに文字色 (トークン由来) と marked (変更範囲内か) を持つ。
 *
 * トークン未取得 (言語不明 / ロード前) でも行全体を無色 1 トークンとして扱い、
 * 変更範囲の強調だけは描画できるようにする。
 *
 * 前提: tokens の content 連結 = text、ranges は昇順かつ互いに素
 * (computeIntraLineRanges の出力契約)。
 */
export function splitSegments(
  text: string,
  tokens: readonly { content: string; color?: string }[] | undefined,
  ranges: readonly ColRange[] | undefined,
): LineSegment[] {
  const effectiveTokens = tokens ?? [{ content: text, color: undefined }];
  const marks = ranges ?? [];

  const out: LineSegment[] = [];
  let offset = 0; // 行頭からの 0-based offset (トークン先頭位置)
  let mi = 0; // 消費中の marks index
  for (const token of effectiveTokens) {
    const tokenEnd = offset + token.content.length;
    let cursor = offset;
    while (cursor < tokenEnd) {
      // cursor 位置までに終わった mark を読み捨てる (end-exclusive)
      while (mi < marks.length && marks[mi].end - 1 <= cursor) mi++;
      const mark = marks[mi];
      let segEnd: number;
      let marked: boolean;
      if (mark === undefined || mark.start - 1 >= tokenEnd) {
        segEnd = tokenEnd;
        marked = false;
      } else if (cursor < mark.start - 1) {
        segEnd = mark.start - 1;
        marked = false;
      } else {
        segEnd = Math.min(mark.end - 1, tokenEnd);
        marked = true;
      }
      out.push({
        text: token.content.slice(cursor - offset, segEnd - offset),
        color: token.color,
        marked,
      });
      cursor = segEnd;
    }
    offset = tokenEnd;
  }
  return out;
}
