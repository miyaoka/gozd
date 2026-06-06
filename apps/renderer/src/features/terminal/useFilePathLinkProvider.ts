import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { usePreviewStore } from "../preview";
import { pathTargetToString, useWorktreeStore } from "../worktree";
import { collectIndentedBlock } from "./collectIndentedBlock";
import {
  type AbsolutePathMatch,
  findAbsolutePathMatches,
  resolveHomeDir,
} from "./findAbsolutePathMatches";
import { findRelativePaths } from "./findRelativePaths";

/**
 * ターミナル出力中のファイルパスを検出し、クリックでファイラー/プレビューに反映する LinkProvider を作成する。
 * - active worktree 内のパス → 相対パスで selectPath（Preview で内容表示、FilerPane で reveal）
 * - 任意の絶対パス（`/Users/<user>/...` / `/tmp/...` / `/var/folders/...` / `~/...` 等）→ 絶対パスで selectPath
 *   - Preview は fsReadFileAbsolute で内容表示する
 *   - FilerPane のツリーは active worktree 配下しか持たないため reveal 対象外
 *     （ツリー上で選択ハイライトされない契約）
 * - Claude Code が明示的改行+インデントで折り返した長いパスも結合して検出
 */
export function createFilePathLinkProvider(terminal: Terminal): ILinkProvider {
  const worktreeStore = useWorktreeStore();
  const previewStore = usePreviewStore();

  return {
    provideLinks(bufferLineNumber, callback) {
      const dir = worktreeStore.dir;
      if (!dir) {
        callback(undefined);
        return;
      }

      const buf = terminal.buffer.active;
      const bufLine = buf.getLine(bufferLineNumber - 1);
      if (!bufLine) {
        callback(undefined);
        return;
      }

      const text = bufLine.translateToString(true);
      const dirPrefix = dir.endsWith("/") ? dir : `${dir}/`;
      const homeDir = resolveHomeDir(dirPrefix);

      // 現在行 + インデント付き継続行を結合したテキストでパスを検索する。
      // dirPrefix が長く1行に収まらない場合に備え、上方向にも辿る。
      const [joinedText, currentLineOffset] = collectIndentedBlock(buf, bufferLineNumber - 1);

      const links: ILink[] = [];

      // 絶対パスの検出（結合テキストから検索し、現在行に範囲があるもののみリンク化）
      findAbsolutePathLinks(
        joinedText,
        currentLineOffset,
        text.length,
        dirPrefix,
        homeDir,
        bufLine,
        bufferLineNumber,
        previewStore,
        links,
      );

      // 相対パスの検出（現在行のテキストのみ）
      findRelativePathLinks(text, bufLine, bufferLineNumber, previewStore, links);

      callback(links.length > 0 ? links : undefined);
    },
  };
}

/**
 * 結合テキストから絶対パスを検出してリンクを作成する。
 * currentLineOffset/currentLineLength で現在行の範囲を指定し、
 * パスが現在行に重なる場合のみリンク化する。
 */
function findAbsolutePathLinks(
  joinedText: string,
  currentLineOffset: number,
  currentLineLength: number,
  dirPrefix: string,
  homeDir: string,
  bufLine: IBufferLine,
  lineNumber: number,
  previewStore: ReturnType<typeof usePreviewStore>,
  links: ILink[],
): void {
  const matches = findAbsolutePathMatches(joinedText, dirPrefix, homeDir);

  for (const match of matches) {
    const clipped = clipMatchToCurrentLine(match, currentLineOffset, currentLineLength);
    if (!clipped) continue;

    pushLink(
      bufLine,
      lineNumber,
      clipped.linkStart,
      clipped.linkEnd,
      pathTargetToString(match.selection),
      (event) => {
        if (!event.shiftKey) return;
        previewStore.requestSelect(match.selection, match.lineNumber);
      },
      links,
    );
  }
}

/**
 * 結合テキスト中の絶対パス match を「現在行の string 範囲」に切り取る。
 * 現在行範囲と一切重ならない match は null を返す。範囲跨ぎは現在行内に収まる部分だけを返す。
 *
 * - currentLineOffset: 結合テキスト中で現在行が始まる string 位置
 * - currentLineLength: 現在行の string 長
 * - 返り値の linkStart / linkEnd: 現在行を起点 (0-based) とした string 範囲
 */
export function clipMatchToCurrentLine(
  match: AbsolutePathMatch,
  currentLineOffset: number,
  currentLineLength: number,
): { linkStart: number; linkEnd: number } | null {
  const currentLineEnd = currentLineOffset + currentLineLength;
  if (match.idx >= currentLineEnd || match.totalEnd <= currentLineOffset) return null;
  return {
    linkStart: Math.max(match.idx, currentLineOffset) - currentLineOffset,
    linkEnd: Math.min(match.totalEnd, currentLineEnd) - currentLineOffset,
  };
}

/** リンクを作成して links に追加する */
function pushLink(
  bufLine: IBufferLine,
  lineNumber: number,
  startIdx: number,
  endIdx: number,
  displayText: string,
  activate: (event: MouseEvent) => void,
  links: ILink[],
): void {
  const startCellX = mapStringIndexToCellX(bufLine, startIdx);
  const endCellX = mapStringIndexToCellX(bufLine, endIdx - 1);

  if (startCellX === -1 || endCellX === -1) return;

  links.push({
    range: {
      start: { x: startCellX + 1, y: lineNumber },
      end: { x: endCellX + 1, y: lineNumber },
    },
    text: displayText,
    activate,
  });
}

/** 相対パスを検出してリンクを作成する */
function findRelativePathLinks(
  text: string,
  bufLine: IBufferLine,
  lineNumber: number,
  previewStore: ReturnType<typeof usePreviewStore>,
  links: ILink[],
): void {
  for (const { path: relPath, startIdx, endIdx, lineNumber: lineNum } of findRelativePaths(text)) {
    // 直前の文字が ~ / なら絶対パスの一部（findAbsolutePathLinks で処理済み）
    const preceding = startIdx > 0 ? text[startIdx - 1] : "";
    if (preceding === "~" || preceding === "/") continue;

    // 絶対パスリンクと重複する場合はスキップ
    if (links.some((l) => overlapsRange(l, startIdx, endIdx, lineNumber))) {
      continue;
    }

    const startCellX = mapStringIndexToCellX(bufLine, startIdx);
    const endCellX = mapStringIndexToCellX(bufLine, endIdx - 1);

    if (startCellX === -1 || endCellX === -1) continue;

    links.push({
      range: {
        start: { x: startCellX + 1, y: lineNumber },
        end: { x: endCellX + 1, y: lineNumber },
      },
      text: relPath,
      activate: (event) => {
        if (!event.shiftKey) return;
        previewStore.requestSelect({ kind: "worktreeRelative", relPath }, lineNum);
      },
    });
  }
}

/** リンクの範囲が指定区間と重複するか判定する（同一行のみ） */
function overlapsRange(link: ILink, startIdx: number, endIdx: number, lineNumber: number): boolean {
  const { start, end } = link.range;
  if (start.y !== lineNumber || end.y !== lineNumber) return false;
  return startIdx < end.x && endIdx > start.x - 1;
}

/**
 * translateToString() の文字列インデックスを、バッファのセル座標（0-based）に変換する。
 * 全角文字は width=2 だが文字列上は1文字なので、セルを走査して正しい位置を求める。
 */
function mapStringIndexToCellX(line: IBufferLine, stringIndex: number): number {
  const cell = line.getCell(0);
  if (!cell) return -1;

  let strOffset = 0;
  for (let cellIdx = 0; cellIdx < line.length; cellIdx++) {
    line.getCell(cellIdx, cell);
    const width = cell.getWidth();
    if (width === 0) continue;

    if (strOffset === stringIndex) {
      return cellIdx;
    }

    strOffset += cell.getChars().length || 1;
  }

  return -1;
}
