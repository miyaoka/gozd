import type { IBuffer, IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { useWorkspaceStore } from "../filer/useWorkspaceStore";
import { findRelativePaths } from "./findRelativePaths";

/** パスの末尾区切り文字 */
const PATH_TERMINATORS = /[\s()}\]>'",:;]/;

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

      // 現在行 + インデント付き継続行を結合したテキストでパスを検索する。
      // dirPrefix が長く1行に収まらない場合に備え、上方向にも辿る。
      const [joinedText, topLineIdx] = collectIndentedBlock(buf, bufferLineNumber - 1);
      const currentLineOffset = getLineOffset(buf, topLineIdx, bufferLineNumber - 1);

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
        workspaceStore,
        links,
      );

      // 相対パスの検出（現在行のテキストのみ）
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
 * 継続行ブロックを収集する。
 * ターミナルのハードラップ（isWrapped）とインデント付き継続行の両方を辿り、
 * 現在行から上方向にブロック先頭を見つけ、下方向に続く限り結合する。
 * 返り値: [結合テキスト, 先頭行の0-basedインデックス]
 */
function collectIndentedBlock(buf: IBuffer, lineIdx: number): [string, number] {
  // 上方向: ハードラップまたはインデント行なら上に辿る
  let topIdx = lineIdx;
  while (topIdx > 0) {
    const line = buf.getLine(topIdx);
    if (!line) break;
    // ハードラップ（isWrapped）なら前の行の続き
    if (line.isWrapped) {
      topIdx--;
      continue;
    }
    const lineText = line.translateToString(true);
    if (lineText.length === 0 || lineText[0] !== " ") break;
    topIdx--;
  }

  // topIdx から下方向に結合
  const parts: string[] = [];
  let idx = topIdx;
  const topLine = buf.getLine(idx);
  if (topLine) {
    parts.push(topLine.translateToString(true));
    idx++;
    let nextLine = buf.getLine(idx);
    while (nextLine) {
      // ハードラップなら折り返しの続き（そのまま結合）
      if (nextLine.isWrapped) {
        parts.push(nextLine.translateToString(true));
        idx++;
        nextLine = buf.getLine(idx);
        continue;
      }
      // インデント付き継続行
      const nextText = nextLine.translateToString(true);
      if (nextText.length === 0 || nextText[0] !== " ") break;
      parts.push(nextText.trimStart());
      idx++;
      nextLine = buf.getLine(idx);
    }
  }

  return [parts.join(""), topIdx];
}

/**
 * 結合テキスト中での、特定行の開始オフセットを算出する。
 * topLineIdx から targetLineIdx までの各行のテキスト長を合算する。
 * ハードラップ行はそのままの長さ、インデント継続行は trimStart 後の長さを使う。
 */
function getLineOffset(buf: IBuffer, topLineIdx: number, targetLineIdx: number): number {
  let offset = 0;
  for (let i = topLineIdx; i < targetLineIdx; i++) {
    const line = buf.getLine(i);
    if (!line) break;
    const text = line.translateToString(true);
    if (i === topLineIdx) {
      offset += text.length;
    } else if (line.isWrapped) {
      // ハードラップ行はそのまま結合されるので全長を加算
      offset += text.length;
    } else {
      // インデント継続行は trimStart して結合されるので、その長さを加算
      offset += text.trimStart().length;
    }
  }
  return offset;
}

/**
 * 結合テキストから絶対パス（`/...` および `~/...`）を検出してリンクを作成する。
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
  workspaceStore: ReturnType<typeof useWorkspaceStore>,
  links: ILink[],
): void {
  const currentLineEnd = currentLineOffset + currentLineLength;
  let searchStart = 0;

  while (searchStart < joinedText.length) {
    const directIdx = joinedText.indexOf(dirPrefix, searchStart);
    const tildeIdx = homeDir ? joinedText.indexOf("~/", searchStart) : -1;

    if (directIdx === -1 && tildeIdx === -1) break;

    const useTilde = tildeIdx !== -1 && (directIdx === -1 || tildeIdx < directIdx);
    const idx = useTilde ? tildeIdx : directIdx;

    let fullPath: string;
    let pathEnd: number;

    if (useTilde) {
      const afterTilde = idx + 2;
      pathEnd = findPathEnd(joinedText, afterTilde);
      fullPath = `${homeDir}/${joinedText.slice(afterTilde, pathEnd)}`;
    } else {
      pathEnd = findPathEnd(joinedText, idx + dirPrefix.length);
      fullPath = joinedText.slice(idx, pathEnd);
    }

    // パスが現在行と重なるかチェック
    if (idx < currentLineEnd && pathEnd > currentLineOffset) {
      const resolvedPath = useTilde ? fullPath : fullPath;
      const selectPath = resolvedPath.startsWith(dirPrefix)
        ? resolvedPath.slice(dirPrefix.length)
        : resolvedPath;

      if (selectPath.length > 0) {
        // 現在行内のリンク範囲を算出
        const linkStart = Math.max(idx, currentLineOffset) - currentLineOffset;
        const linkEnd = Math.min(pathEnd, currentLineEnd) - currentLineOffset;

        pushLink(
          bufLine,
          lineNumber,
          linkStart,
          linkEnd,
          selectPath,
          (event) => {
            if (!event.shiftKey) return;
            workspaceStore.selectPath(selectPath);
          },
          links,
        );
      }
    }

    searchStart = pathEnd;
  }
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
  workspaceStore: ReturnType<typeof useWorkspaceStore>,
  links: ILink[],
): void {
  for (const { path: relPath, startIdx, endIdx } of findRelativePaths(text)) {
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
