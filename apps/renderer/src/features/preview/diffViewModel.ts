/**
 * git が返す hunk 列を diff ビューの描画アイテムへ変換する純ロジック。
 *
 * 入力は `rpcGitDiffHunks` の結果 (hunks + 総行数) と、任意で Shiki のトークン配列 /
 * 展開済みバーの行配列。出力は unified / split 両モードの描画アイテム列で、DOM も Vue も
 * 介さない。描画に必要な判断 (省略バーの位置、左右のペアリング、行内変更範囲の割り当て、
 * Cmd+A scope の section 境界) はすべてここで確定させ、SFC 側は結果を並べるだけにする。
 *
 * unified diff の invariant (hunk 間 / 末尾の unchanged 行数が old / new で一致する) が
 * 破れた入力は throw する。呼び出し側はこれを error UI へ倒す。
 */
import type { DiffExpandedLine, DiffHunk } from "@gozd/rpc";
import { type ColRange, computeIntraLineRanges } from "./intraLineDiff";
import type { ThemedToken } from "./useHighlight";

export type DiffLineKindName = "added" | "removed" | "unchanged";

interface DiffLineItem {
  type: "line";
  kind: DiffLineKindName;
  text: string;
  oldLineNo?: number;
  newLineNo?: number;
}

/**
 * バーで省略された unchanged 範囲。1-based。
 * unified diff semantics 上、hunk 間 / 末尾 trailing の unchanged 行数は old / new 両側で常に同じ
 * (両側に対応がある context 範囲なので)。この invariant を shape で enforce するため `lines` を 1 本だけ持つ。
 * `oldEnd = oldStart + lines - 1`、`newEnd = newStart + lines - 1` で導出する。
 */
export interface DiffBarItem {
  type: "hunk-bar";
  oldStart: number;
  newStart: number;
  lines: number;
}

export type DiffViewItem = DiffLineItem | DiffBarItem;

/**
 * split view の 1 行。`oldText` / `newText` のいずれかが undefined の row は modified 行で
 * 片側だけが存在するケース (純粋な add / remove、または run 長が左右で不揃いの余り)。
 * context (両側同じ unchanged 行) は両側に同じテキストと行番号を持つ。
 */
export interface DiffSplitRowItem {
  type: "split-row";
  kind: "context" | "modified";
  oldLineNo?: number;
  oldText?: string;
  newLineNo?: number;
  newText?: string;
}

export type DiffSplitViewItem = DiffSplitRowItem | DiffBarItem;

/** 行内 (文字単位) 変更範囲。key は old / new 側それぞれの 1-based 絶対行番号 */
export interface IntraLineRangeMaps {
  old: Map<number, ColRange[]>;
  new: Map<number, ColRange[]>;
}

type RenderedUnifiedLine = DiffLineItem & {
  tokens?: ThemedToken[];
  innerRanges?: ColRange[];
};

type RenderedSplitLine = DiffSplitRowItem & {
  oldTokens?: ThemedToken[];
  newTokens?: ThemedToken[];
  oldInnerRanges?: ColRange[];
  newInnerRanges?: ColRange[];
};

interface DiffSection<T> {
  type: "section";
  lines: T[];
}

export type UnifiedItem = DiffBarItem | DiffSection<RenderedUnifiedLine>;
export type SplitItem = DiffBarItem | DiffSection<RenderedSplitLine>;

interface BaseItems {
  items: DiffViewItem[];
  splitItems: DiffSplitViewItem[];
  ranges: IntraLineRangeMaps;
}

/**
 * 展開済み hunk-bar のキャッシュ。key は `barKey`、value は `rpcGitDiffExpandLines` の行配列。
 */
type ExpansionMap = ReadonlyMap<string, DiffExpandedLine[]>;

/**
 * バーの識別子。oldStart / newStart / lines を全て含むので、再 fetch で bar 構成が変わった場合は
 * 自動的にキャッシュが効かなくなる (key が一致しないため undefined 扱い)。
 */
export function barKey(bar: DiffBarItem): string {
  return `${bar.oldStart}-${bar.newStart}-${bar.lines}`;
}

export function barLabel(item: DiffBarItem): string {
  return `${item.lines} unchanged line${item.lines === 1 ? "" : "s"}`;
}

/** 行番号カラムの幅。両側の総行数のうち桁数が多い方に合わせる */
export function lineNoWidth(oldTotal: number, newTotal: number): string {
  const maxLine = Math.max(oldTotal, newTotal, 1);
  return `${String(maxLine).length}ch`;
}

/**
 * hunk 内の 1 セグメント。context 1 行、または「連続する removed run + added run」の
 * 1 変更ブロック。unified / split の展開と行内 diff の run 対象抽出が同じ走査を必要と
 * するため、hunk lines の走査 (絶対行番号の採番 + run のグルーピング) をここに一本化する。
 */
type HunkSegment =
  | { kind: "context"; oldLineNo: number; newLineNo: number; text: string }
  | {
      kind: "run";
      removeds: { lineNo: number; text: string }[];
      addeds: { lineNo: number; text: string }[];
    };

function collectHunkSegments(h: DiffHunk): HunkSegment[] {
  const segments: HunkSegment[] = [];
  let oldLine = h.oldStart;
  let newLine = h.newStart;
  let i = 0;
  while (i < h.lines.length) {
    const line = h.lines[i];
    if (line.kind === "context") {
      segments.push({ kind: "context", oldLineNo: oldLine, newLineNo: newLine, text: line.text });
      oldLine += 1;
      newLine += 1;
      i += 1;
      continue;
    }

    const removeds: { lineNo: number; text: string }[] = [];
    while (i < h.lines.length && h.lines[i].kind === "removed") {
      removeds.push({ lineNo: oldLine, text: h.lines[i].text });
      oldLine += 1;
      i += 1;
    }
    const addeds: { lineNo: number; text: string }[] = [];
    while (i < h.lines.length && h.lines[i].kind === "added") {
      addeds.push({ lineNo: newLine, text: h.lines[i].text });
      newLine += 1;
      i += 1;
    }
    segments.push({ kind: "run", removeds, addeds });
  }
  return segments;
}

/**
 * 1 hunk のセグメント列を unified 行アイテムに展開する。
 * run は removed → added の順に並べる (git の unified diff 出力と同じ並び)。
 */
function expandHunkLinesUnified(segments: HunkSegment[], items: DiffViewItem[]): void {
  for (const seg of segments) {
    if (seg.kind === "context") {
      items.push({
        type: "line",
        kind: "unchanged",
        text: seg.text,
        oldLineNo: seg.oldLineNo,
        newLineNo: seg.newLineNo,
      });
      continue;
    }
    for (const r of seg.removeds) {
      items.push({ type: "line", kind: "removed", text: r.text, oldLineNo: r.lineNo });
    }
    for (const a of seg.addeds) {
      items.push({ type: "line", kind: "added", text: a.text, newLineNo: a.lineNo });
    }
  }
}

/**
 * 1 hunk のセグメント列を split 行アイテムに展開する。
 * unchanged は両側にテキストを持つ context row、run は removed run と added run を
 * 貪欲にペアリングして同じ row に左右配置する。run 長が不揃いの場合は
 * 余った片側だけの row が並ぶ。
 */
function expandHunkLinesSplit(segments: HunkSegment[], items: DiffSplitViewItem[]): void {
  for (const seg of segments) {
    if (seg.kind === "context") {
      items.push({
        type: "split-row",
        kind: "context",
        oldLineNo: seg.oldLineNo,
        oldText: seg.text,
        newLineNo: seg.newLineNo,
        newText: seg.text,
      });
      continue;
    }
    const pairCount = Math.max(seg.removeds.length, seg.addeds.length);
    for (let j = 0; j < pairCount; j++) {
      const r = seg.removeds[j];
      const a = seg.addeds[j];
      items.push({
        type: "split-row",
        kind: "modified",
        oldLineNo: r?.lineNo,
        oldText: r?.text,
        newLineNo: a?.lineNo,
        newText: a?.text,
      });
    }
  }
}

/**
 * 1 ファイル分の行内 diff 計算に許す合計時間。VSCode の diff は worker で走るが gozd の
 * 行内 diff はメインスレッド同期実行のため、巨大 diff (lock ファイル等) で UI が固まらない
 * よう全 run 合算の予算で打ち切る。予算切れ以降の run は行単位表示に degrade する。
 */
const INTRA_LINE_DIFF_BUDGET_MS = 500;

/**
 * 変更ブロック (removed run × added run 両方が非空のもの) の行内変更範囲を収集し、
 * 絶対行番号 key のマップに積む。予算切れは想定内の degrade だが、観察できるよう
 * 初回だけ stderr にログを残す (budget.exhausted フラグで 1 回に抑制)。
 */
function collectIntraLineRanges(
  segments: HunkSegment[],
  oldRanges: Map<number, ColRange[]>,
  newRanges: Map<number, ColRange[]>,
  budget: { deadline: number; exhausted: boolean },
): void {
  for (const seg of segments) {
    if (seg.kind !== "run") continue;
    if (seg.removeds.length === 0 || seg.addeds.length === 0) continue;
    const remaining = budget.deadline - performance.now();
    if (remaining <= 0) {
      if (!budget.exhausted) {
        budget.exhausted = true;
        console.error(
          `[diffViewModel] intra-line diff budget (${INTRA_LINE_DIFF_BUDGET_MS}ms) exhausted; ` +
            "remaining runs degrade to line-level highlight",
        );
      }
      return;
    }
    const result = computeIntraLineRanges(
      seg.removeds.map((r) => r.text),
      seg.addeds.map((a) => a.text),
      remaining,
    );
    // undefined = hitTimeout。この run だけ行内ハイライトなし (従来の行単位表示) に degrade する
    if (result === undefined) continue;
    for (const [idx, list] of result.old) oldRanges.set(seg.removeds[idx].lineNo, list);
    for (const [idx, list] of result.new) newRanges.set(seg.addeds[idx].lineNo, list);
  }
}

/**
 * hunks を走査して unified / split の base items を 1 度に組み立てる。
 * hunk 間 / 末尾の連続 unchanged 範囲は `DiffBarItem` で省略する。invariant 違反は throw。
 * 0-line hunk (新規 / 削除ファイル) の扱いは unified / split で同一なので gap 計算をここに集約する。
 */
export function buildBaseItems(hs: DiffHunk[], oldTotal: number, newTotal: number): BaseItems {
  const items: DiffViewItem[] = [];
  const splitItems: DiffSplitViewItem[] = [];
  const oldInnerRanges = new Map<number, ColRange[]>();
  const newInnerRanges = new Map<number, ColRange[]>();
  const intraLineBudget = {
    deadline: performance.now() + INTRA_LINE_DIFF_BUDGET_MS,
    exhausted: false,
  };
  let prevOldEnd = 0;
  let prevNewEnd = 0;

  for (let idx = 0; idx < hs.length; idx++) {
    const h = hs[idx];
    // 新規ファイル (`@@ -0,0 +A,B @@`) / 削除ファイル (`@@ -X,Y +0,0 @@`) では該当 side の
    // start = 0, lines = 0 になる。この side には gap も末尾も存在しないため、
    // gap 計算ではあたかも `prevEnd + 1` から始まる 0 長 hunk とみなして 0 にする。
    // この正規化を入れないと `0 - 0 - 1 = -1` の負 gap が出て invariant 違反として throw され、
    // 新規ファイル / 削除ファイルの diff プレビューが壊れる。
    const effectiveOldStart = h.oldLines === 0 ? prevOldEnd + 1 : h.oldStart;
    const effectiveNewStart = h.newLines === 0 ? prevNewEnd + 1 : h.newStart;
    const oldGap = effectiveOldStart - prevOldEnd - 1;
    const newGap = effectiveNewStart - prevNewEnd - 1;
    if (oldGap !== newGap) {
      throw new Error(
        `unified diff invariant violation at hunk #${idx}: oldGap=${oldGap} newGap=${newGap} ` +
          `(hunk oldStart=${h.oldStart} oldLines=${h.oldLines} newStart=${h.newStart} ` +
          `newLines=${h.newLines}, after prevOldEnd=${prevOldEnd} prevNewEnd=${prevNewEnd})`,
      );
    }
    if (oldGap > 0) {
      const bar: DiffBarItem = {
        type: "hunk-bar",
        oldStart: prevOldEnd + 1,
        newStart: prevNewEnd + 1,
        lines: oldGap,
      };
      items.push(bar);
      splitItems.push(bar);
    }

    const segments = collectHunkSegments(h);
    expandHunkLinesUnified(segments, items);
    expandHunkLinesSplit(segments, splitItems);
    collectIntraLineRanges(segments, oldInnerRanges, newInnerRanges, intraLineBudget);

    if (h.oldLines > 0) prevOldEnd = h.oldStart + h.oldLines - 1;
    if (h.newLines > 0) prevNewEnd = h.newStart + h.newLines - 1;
  }

  const oldTrailing = oldTotal - prevOldEnd;
  const newTrailing = newTotal - prevNewEnd;
  if (oldTrailing !== newTrailing) {
    throw new Error(
      `unified diff trailing invariant violation: old=${oldTrailing} new=${newTrailing} ` +
        `(oldTotal=${oldTotal} newTotal=${newTotal} prevOldEnd=${prevOldEnd} prevNewEnd=${prevNewEnd}, ` +
        `hunks=${hs.length})`,
    );
  }
  if (oldTrailing > 0) {
    const bar: DiffBarItem = {
      type: "hunk-bar",
      oldStart: prevOldEnd + 1,
      newStart: prevNewEnd + 1,
      lines: oldTrailing,
    };
    items.push(bar);
    splitItems.push(bar);
  }

  return { items, splitItems, ranges: { old: oldInnerRanges, new: newInnerRanges } };
}

function buildRenderedLine(
  item: DiffLineItem,
  orig: ThemedToken[][] | undefined,
  curr: ThemedToken[][] | undefined,
  ranges: IntraLineRangeMaps,
): RenderedUnifiedLine {
  let tokens: ThemedToken[] | undefined;
  if (orig && curr) {
    if (item.kind === "removed" && item.oldLineNo !== undefined) {
      tokens = orig[item.oldLineNo - 1];
    } else if (item.newLineNo !== undefined) {
      tokens = curr[item.newLineNo - 1];
    }
  }
  let innerRanges: ColRange[] | undefined;
  if (item.kind === "removed" && item.oldLineNo !== undefined) {
    innerRanges = ranges.old.get(item.oldLineNo);
  } else if (item.kind === "added" && item.newLineNo !== undefined) {
    innerRanges = ranges.new.get(item.newLineNo);
  }
  return { ...item, tokens, innerRanges };
}

function buildRenderedSplitRow(
  row: DiffSplitRowItem,
  orig: ThemedToken[][] | undefined,
  curr: ThemedToken[][] | undefined,
  ranges: IntraLineRangeMaps,
): RenderedSplitLine {
  const oldTokens = orig && row.oldLineNo !== undefined ? orig[row.oldLineNo - 1] : undefined;
  const newTokens = curr && row.newLineNo !== undefined ? curr[row.newLineNo - 1] : undefined;
  // 行内 range は modified 行にしか積まれないが、lookup は行番号だけで安全
  // (context 行の行番号は collectIntraLineRanges の対象外なので必ず miss する)
  const oldInnerRanges =
    row.kind === "modified" && row.oldLineNo !== undefined
      ? ranges.old.get(row.oldLineNo)
      : undefined;
  const newInnerRanges =
    row.kind === "modified" && row.newLineNo !== undefined
      ? ranges.new.get(row.newLineNo)
      : undefined;
  return { ...row, oldTokens, newTokens, oldInnerRanges, newInnerRanges };
}

/** unified の描画行: 展開済みバーを unchanged 行に置換した後、tokens と行内 range を埋め込む */
export function buildUnifiedRenderRows(
  baseItems: DiffViewItem[],
  orig: ThemedToken[][] | undefined,
  curr: ThemedToken[][] | undefined,
  ranges: IntraLineRangeMaps,
  expansions: ExpansionMap,
): (RenderedUnifiedLine | DiffBarItem)[] {
  const rendered: (RenderedUnifiedLine | DiffBarItem)[] = [];
  for (const item of baseItems) {
    if (item.type === "hunk-bar") {
      const lines = expansions.get(barKey(item));
      if (lines === undefined) {
        rendered.push(item);
        continue;
      }
      for (const ln of lines) {
        rendered.push(
          buildRenderedLine(
            {
              type: "line",
              kind: "unchanged",
              text: ln.newText,
              oldLineNo: ln.oldLineNo,
              newLineNo: ln.newLineNo,
            },
            orig,
            curr,
            ranges,
          ),
        );
      }
      continue;
    }
    rendered.push(buildRenderedLine(item, orig, curr, ranges));
  }
  return rendered;
}

/** split の描画行: 展開済みバーを context row に置換した後、両側のトークンと行内 range を埋め込む */
export function buildSplitRenderRows(
  baseSplitItems: DiffSplitViewItem[],
  orig: ThemedToken[][] | undefined,
  curr: ThemedToken[][] | undefined,
  ranges: IntraLineRangeMaps,
  expansions: ExpansionMap,
): (RenderedSplitLine | DiffBarItem)[] {
  const rendered: (RenderedSplitLine | DiffBarItem)[] = [];
  for (const item of baseSplitItems) {
    if (item.type === "hunk-bar") {
      const lines = expansions.get(barKey(item));
      if (lines === undefined) {
        rendered.push(item);
        continue;
      }
      for (const ln of lines) {
        rendered.push(
          buildRenderedSplitRow(
            {
              type: "split-row",
              kind: "context",
              oldLineNo: ln.oldLineNo,
              oldText: ln.oldText,
              newLineNo: ln.newLineNo,
              newText: ln.newText,
            },
            orig,
            curr,
            ranges,
          ),
        );
      }
      continue;
    }
    rendered.push(buildRenderedSplitRow(item, orig, curr, ranges));
  }
  return rendered;
}

function isBar(row: { type: string }): row is DiffBarItem {
  return row.type === "hunk-bar";
}

/**
 * Cmd+A scope を「開かれている可視チャンク 1 つ」に閉じ込めるため、描画行を hunk-bar 境界で
 * section に分割する。section が contenteditable の editing host になり、hunk-bar 自体は
 * contenteditable の **外** に sibling として置く構造に template 側を組む。
 *
 * 配列要素は `DiffBarItem` か `DiffSection` のどちらかで、並び順が DOM 描画順と一致する。
 * hunk-bar の前後関係 / 末尾 trailing は flat 配列にそのまま現れるため、template の v-for
 * 1 段で素直に描ける。
 */
export function splitIntoSections<T extends { type: "line" | "split-row" }>(
  rows: readonly (T | DiffBarItem)[],
): (DiffBarItem | DiffSection<T>)[] {
  const out: (DiffBarItem | DiffSection<T>)[] = [];
  let current: T[] = [];
  for (const row of rows) {
    if (isBar(row)) {
      if (current.length > 0) {
        out.push({ type: "section", lines: current });
        current = [];
      }
      out.push(row);
    } else {
      current.push(row);
    }
  }
  if (current.length > 0) out.push({ type: "section", lines: current });
  return out;
}
