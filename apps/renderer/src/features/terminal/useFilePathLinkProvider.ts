import type { IBuffer, IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { useWorkspaceStore } from "../filer/useWorkspaceStore";

/** パスの末尾区切り文字 */
const PATH_TERMINATORS = /[\s()}\]>'",:;]/;

/**
 * 相対パスの候補を検出する正規表現。
 * ワード文字で始まり、`/` 区切りで2セグメント以上あり、最後のセグメントにファイル拡張子を持つパターン。
 */
const REL_PATH_REGEX = /[\w@.-]+(?:\/[\w@.-]+)*\/[\w@-]+\.[\w]+/g;

/**
 * ターミナル出力中のファイルパスを検出し、クリックでファイラー/プレビューに反映する LinkProvider を作成する。
 * - ワークスペース内のパス → 相対パスで selectPath
 * - ワークスペース外のパス（`~/...` 含む）→ 絶対パスで selectPath（プレビューが fsReadFileAbsolute で読む）
 * - Claude Code が明示的改行+インデントで折り返した長いパスも結合して検出
 */
export function createFilePathLinkProvider(terminal: Terminal): ILinkProvider {
  const workspaceStore = useWorkspaceStore();

  return {
    provideLinks(bufferLineNumber, callback) {
      const dir = workspaceStore.dir;
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

      const links: ILink[] = [];

      // 絶対パスの検出（`/...` および `~/...`）
      findAbsolutePathLinks(
        text,
        dirPrefix,
        homeDir,
        bufLine,
        bufferLineNumber,
        buf,
        workspaceStore,
        links,
      );

      // 相対パスの検出
      findRelativePathLinks(text, bufLine, bufferLineNumber, workspaceStore, links);

      callback(links.length > 0 ? links : undefined);
    },
  };
}

/**
 * `~/` プレフィックスを展開するために、dirPrefix からホームディレクトリを推定する。
 * dirPrefix が `/Users/miyaoka/...` のような形式なら `/Users/miyaoka` を返す。
 */
function resolveHomeDir(dirPrefix: string): string {
  const match = dirPrefix.match(/^(\/(?:Users|home)\/[^/]+)\//);
  if (match) return match[1]!;
  return "";
}

/**
 * 絶対パス（`/...` および `~/...`）を検出してリンクを作成する。
 * ワークスペース内なら相対パス、外なら絶対パスで selectPath する。
 */
function findAbsolutePathLinks(
  text: string,
  dirPrefix: string,
  homeDir: string,
  bufLine: IBufferLine,
  lineNumber: number,
  buf: IBuffer,
  workspaceStore: ReturnType<typeof useWorkspaceStore>,
  links: ILink[],
): void {
  let searchStart = 0;

  while (searchStart < text.length) {
    const directIdx = text.indexOf(dirPrefix, searchStart);
    const tildeIdx = homeDir ? text.indexOf("~/", searchStart) : -1;

    if (directIdx === -1 && tildeIdx === -1) break;

    const useTilde = tildeIdx !== -1 && (directIdx === -1 || tildeIdx < directIdx);
    const idx = useTilde ? tildeIdx : directIdx;

    if (useTilde) {
      const afterTilde = idx + 2;
      const end = findPathEnd(text, afterTilde);
      let expandedPath = `${homeDir}/${text.slice(afterTilde, end)}`;

      if (end === text.length) {
        const continuation = getPathContinuation(buf, lineNumber);
        if (continuation.length > 0) {
          expandedPath += continuation;
        }
      }

      // ワークスペース内なら相対パス、外なら絶対パスで selectPath
      const selectPath = expandedPath.startsWith(dirPrefix)
        ? expandedPath.slice(dirPrefix.length)
        : expandedPath;

      if (selectPath.length > 0) {
        pushLink(
          bufLine,
          lineNumber,
          idx,
          Math.min(end, text.length),
          selectPath,
          () => {
            workspaceStore.selectPath(selectPath);
          },
          links,
        );
      }

      searchStart = end;
    } else {
      const end = findPathEnd(text, idx + dirPrefix.length);
      let pathText = text.slice(idx, end);

      if (end === text.length) {
        const continuation = getPathContinuation(buf, lineNumber);
        if (continuation.length > 0) {
          pathText += continuation;
        }
      }

      const relPath = pathText.slice(dirPrefix.length);
      if (relPath.length > 0) {
        pushLink(
          bufLine,
          lineNumber,
          idx,
          Math.min(end, text.length),
          relPath,
          () => {
            workspaceStore.selectPath(relPath);
          },
          links,
        );
      }

      searchStart = end;
    }
  }
}

/** リンクを作成して links に追加する */
function pushLink(
  bufLine: IBufferLine,
  lineNumber: number,
  startIdx: number,
  endIdx: number,
  displayText: string,
  activate: () => void,
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

/**
 * 次行以降のテキストからパスの続きを取得する。
 * Claude Code は長いパスを改行+インデントで折り返すため、
 * 次行がインデント付きかつパス文字で始まる場合にのみ結合する。
 */
function getPathContinuation(buf: IBuffer, currentLineNumber: number): string {
  let continuation = "";
  let nextLineIdx = currentLineNumber; // currentLineNumber は 1-based なので 0-based の次行インデックスと一致

  while (true) {
    const nextLine = buf.getLine(nextLineIdx);
    if (!nextLine) break;

    const nextText = nextLine.translateToString(true);

    // 次行が先頭インデント付きでない場合は折り返しではない
    if (nextText.length === 0 || nextText[0] !== " ") break;

    const trimmed = nextText.trimStart();

    if (trimmed.length === 0 || PATH_TERMINATORS.test(trimmed[0]!)) break;

    const end = findPathEnd(trimmed, 0);
    continuation += trimmed.slice(0, end);

    if (end < trimmed.length) break;

    nextLineIdx++;
  }

  return continuation;
}

/** 相対パスを検出してリンクを作成する */
function findRelativePathLinks(
  text: string,
  bufLine: IBufferLine,
  lineNumber: number,
  workspaceStore: ReturnType<typeof useWorkspaceStore>,
  links: ILink[],
): void {
  REL_PATH_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = REL_PATH_REGEX.exec(text)) !== null) {
    const startIdx = match.index;
    const endIdx = startIdx + match[0]!.length;

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

    const relPath = match[0]!;
    links.push({
      range: {
        start: { x: startCellX + 1, y: lineNumber },
        end: { x: endCellX + 1, y: lineNumber },
      },
      text: relPath,
      activate: () => {
        workspaceStore.selectPath(relPath);
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

/** パスの末尾位置を探す（区切り文字 or 行末まで） */
function findPathEnd(text: string, from: number): number {
  let end = from;
  while (end < text.length && !PATH_TERMINATORS.test(text[end]!)) {
    end++;
  }
  return end;
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
