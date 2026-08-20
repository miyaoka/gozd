import { tryCatch } from "@gozd/shared";
import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { logEvent } from "../../shared/debug";
import { usePreviewStore } from "../preview";
import {
  joinAbsRel,
  normalizeAbsolute,
  pathTargetToString,
  useWorktreeStore,
  type PathTarget,
} from "../worktree";
import { collectJoinCandidates, type JoinedText } from "./collectJoinCandidates";
import type { CwdTracker } from "./cwdTracker";
import {
  type AbsolutePathMatch,
  findAbsolutePathMatches,
  resolveHomeDir,
} from "./findAbsolutePathMatches";
import { findRelativePaths } from "./findRelativePaths";
import { rpcFsExistsAbsolute } from "./rpc";

/**
 * ターミナル出力中のファイルパスを検出し、クリックでファイラー/プレビューに反映する LinkProvider を作成する。
 * - active worktree 内のパス → 相対パスで selectPath（Preview で内容表示、FilerPane で reveal）
 * - 任意の絶対パス（`/Users/<user>/...` / `/tmp/...` / `/var/folders/...` / `~/...` 等）→ 絶対パスで selectPath
 *   - Preview は fsReadFileAbsolute で内容表示する
 *   - FilerPane のツリーは active worktree 配下しか持たないため reveal 対象外
 *     （ツリー上で選択ハイライトされない契約）
 * - 相対パスは「その行が出力された時点のシェル cwd」（OSC 7 遷移を cwdTracker が行位置つきで
 *   追跡）を基準に解決する。cwd 不明（OSC 7 を送らないシェル / 最初の遷移より前の行）は
 *   worktree root 基準に fallback する
 * - 複数行に折り返された長いパスは結合して検出する
 *
 * 折り返しがどこから始まりどこで終わるかはバッファの形状から判別できない（折り返し幅は
 * 出力時の端末幅で決まり、その後のリサイズで痕跡が消える）。そのため**結合範囲を変えた候補を
 * すべて出し、実在するものを採用する**。結合しない範囲も候補の 1 つとして含む。
 */
export function createFilePathLinkProvider(
  terminal: Terminal,
  cwdTracker: CwdTracker,
): ILinkProvider {
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

      // 結合範囲を変えた候補をすべて集める（現在行のみの範囲も含む）
      const candidates: PathCandidate[] = collectJoinCandidates(buf, bufferLineNumber - 1).flatMap(
        (joined) => absolutePathCandidates(joined, text.length, dirPrefix, homeDir),
      );

      const cwd = cwdTracker.cwdAtLine(bufferLineNumber - 1);
      candidates.push(...relativePathCandidates(text, dirPrefix, cwd));

      void selectExisting(candidates).then((selected) => {
        const links: ILink[] = [];

        for (const candidate of selected) {
          pushLink(
            bufLine,
            bufferLineNumber,
            candidate.linkStart,
            candidate.linkEnd,
            pathTargetToString(candidate.selection),
            (event) => {
              if (!event.shiftKey) return;
              previewStore.requestSelect(candidate.selection, candidate.lineNumber);
            },
            links,
          );
        }

        callback(links.length > 0 ? links : undefined);
      });
    },
  };
}

/** 現在行に重なるパス候補。絶対パス経路と相対パス経路で共通 */
export interface PathCandidate {
  /** 現在行を起点 (0-based) とした string 範囲 */
  linkStart: number;
  linkEnd: number;
  /** 実在確認に使う絶対パス */
  absPath: string;
  selection: PathTarget;
  lineNumber?: number;
}

/**
 * 結合テキストから絶対パス候補を集め、現在行に重なるものだけ返す。
 *
 * 範囲は raw 行（`translateToString` した現在行）を起点に返す。結合でインデントを落として
 * いる場合、結合テキスト上の index は落とした幅だけ手前にずれているため、戻して合わせる。
 */
function absolutePathCandidates(
  joined: JoinedText,
  rawLineLength: number,
  dirPrefix: string,
  homeDir: string,
): PathCandidate[] {
  const candidates: PathCandidate[] = [];
  // 結合テキスト中で現在行が占める長さ。インデントを落とした分だけ raw より短い
  const currentLineLength = rawLineLength - joined.currentLineTrimmed;

  for (const match of findAbsolutePathMatches(joined.text, dirPrefix, homeDir)) {
    const clipped = clipMatchToCurrentLine(match, joined.currentLineOffset, currentLineLength);
    if (!clipped) continue;

    candidates.push({
      linkStart: clipped.linkStart + joined.currentLineTrimmed,
      linkEnd: clipped.linkEnd + joined.currentLineTrimmed,
      absPath: absPathOf(match.selection, dirPrefix),
      selection: match.selection,
      lineNumber: match.lineNumber,
    });
  }

  return candidates;
}

/**
 * 1 hover で実在確認する一意パスの上限。端末出力は untrusted で、行に並ぶパス風トークンの
 * 数を出力側が決められる。main 側の存在確認は同期呼び出しのため、上限を置かないと
 * 1 度の hover が main の停止時間を伸ばす。
 */
const MAX_VERIFIED_PATHS = 32;

/** 候補の実在を問い合わせ、選別して返す */
async function selectExisting(candidates: PathCandidate[]): Promise<PathCandidate[]> {
  if (candidates.length === 0) return [];

  // 結合範囲が違っても同じパスに解決する候補が多いため、問い合わせは一意なパスに畳む
  const uniquePaths = [...new Set(candidates.map((c) => c.absPath))];
  const absolutePaths = uniquePaths.slice(0, MAX_VERIFIED_PATHS);
  if (uniquePaths.length > absolutePaths.length) {
    logEvent(
      "terminal-link",
      "verify-truncated",
      "",
      `unique=${uniquePaths.length} limit=${MAX_VERIFIED_PATHS}`,
    );
  }

  const stat = await tryCatch(rpcFsExistsAbsolute({ absolutePaths }));
  if (!stat.ok) {
    logEvent("terminal-link", "verify-failed", "", String(stat.error));
    return [];
  }

  // index ではなくパス自体で引く。候補と応答の並びがずれても無関係なパスに解決しない
  const existsByPath = new Map(absolutePaths.map((path, i) => [path, stat.value.exists[i]]));
  const selected = selectBestCandidates(candidates, existsByPath);

  // 候補はあったのに 1 つも実在しないと、リンクが無音で消える。検出は当たっているのに
  // 解決先が誤っているケースと区別できるよう、落ちた候補を残す。
  // 同じ行への hover は同じ候補集合を繰り返すため、連続する重複は畳む（イベントログは
  // 全 feature 共有の ring buffer で、高頻度の発火が他チャンネルの記録を押し出す）
  if (selected.length === 0) logMissingCandidates(absolutePaths);
  return selected;
}

/** 直近に記録した「実在しなかった候補集合」。連続する同一集合を畳むために持つ */
let lastMissingKey = "";

/** 候補が 1 つも実在しなかったことを記録する。直前と同じ集合なら畳む */
function logMissingCandidates(absolutePaths: string[]): void {
  const key = absolutePaths.join(" ");
  if (key === lastMissingKey) return;
  lastMissingKey = key;

  const shown = absolutePaths.slice(0, 3).join(" ");
  const detail = absolutePaths.length > 3 ? `n=${absolutePaths.length}: ${shown} …` : shown;
  logEvent("terminal-link", "no-candidate-exists", "", detail);
}

/**
 * 実在する候補だけを残し、範囲が重なるものは 1 つに絞る。
 *
 * 優先は「行の上でより広く覆うもの」、同率なら「解決先のパスが長いもの」。前者は絶対パスと
 * 相対パスの競合を決める（`/Users/me/src/x.ts` は `src/x.ts` を含む）。後者は結合テキストと
 * 現在行の競合を決める（覆う範囲は同じで、結合が正しければ解決先が行をまたいで長くなる）。
 *
 * export は test 可能性のためであり、feature 内部の他モジュールから再利用する想定はない
 * （`clipMatchToCurrentLine` と同じ規律）。
 */
export function selectBestCandidates(
  candidates: PathCandidate[],
  existsByPath: ReadonlyMap<string, boolean>,
): PathCandidate[] {
  const existing = candidates
    .filter((c) => existsByPath.get(c.absPath) === true)
    .sort(
      (a, b) =>
        b.linkEnd - b.linkStart - (a.linkEnd - a.linkStart) || b.absPath.length - a.absPath.length,
    );

  const selected: PathCandidate[] = [];
  for (const candidate of existing) {
    if (selected.some((s) => overlapsCandidate(s, candidate))) continue;
    selected.push(candidate);
  }

  return selected;
}

/** 現在行内の string 範囲が重なるか */
function overlapsCandidate(a: PathCandidate, b: PathCandidate): boolean {
  return a.linkStart < b.linkEnd && b.linkStart < a.linkEnd;
}

/**
 * 結合テキスト中の絶対パス match を「現在行の string 範囲」に切り取る。
 * 現在行範囲と一切重ならない match は null を返す。範囲跨ぎは現在行内に収まる部分だけを返す。
 *
 * - currentLineOffset: 結合テキスト中で現在行の中身が始まる string 位置
 * - currentLineLength: 結合テキスト中で現在行が占める長さ（インデントを落とした後の長さ）
 * - 返り値の linkStart / linkEnd: 結合テキスト上の現在行を起点 (0-based) とした範囲。
 *   raw 行の index へ戻すのは呼び出し側の責務（落とした幅を足す）
 *
 * export は test 可能性のためであり、feature 内部の他モジュールから再利用する想定はない。
 * 外部 feature からの利用は terminal feature の barrel (`index.ts`) に載せないことで防ぐ。
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

/** 現在行のテキストから相対パス候補を集める */
function relativePathCandidates(
  text: string,
  dirPrefix: string,
  cwd: string | undefined,
): PathCandidate[] {
  const candidates: PathCandidate[] = [];

  for (const { path: relPath, startIdx, endIdx, lineNumber } of findRelativePaths(text)) {
    // 直前の文字が ~ / なら絶対パスの一部（絶対パス候補として処理済み）
    const preceding = startIdx > 0 ? text[startIdx - 1] : "";
    if (preceding === "~" || preceding === "/") continue;

    const selection = resolveRelativePathTarget(relPath, dirPrefix, cwd);
    candidates.push({
      linkStart: startIdx,
      linkEnd: endIdx,
      absPath: absPathOf(selection, dirPrefix),
      selection,
      lineNumber,
    });
  }

  return candidates;
}

/** 実在確認に使う絶対パスを求める */
function absPathOf(selection: PathTarget, dirPrefix: string): string {
  if (selection.kind === "absolute") return selection.absPath;
  return `${dirPrefix}${selection.relPath}`;
}

/**
 * ターミナル出力中の相対パスを PathTarget に解決する。
 *
 * ツール（tsc / eslint 等）はパスを実行時の pwd 基準で出力するため、worktree root 基準で
 * 解決するとサブディレクトリで実行した出力のリンク先がずれる。その行の出力時点の
 * シェル cwd（cwdTracker）を基準に絶対パス化し、worktree 内に収まれば worktreeRelative
 * （filer reveal が成立）、worktree 外（別 repo に cd した場合等）は absolute に倒す。
 *
 * - cwd 不明（OSC 7 を送らないシェル / 最初の遷移より前の行）は従来どおり worktree root 基準
 * - dirPrefix は worktree root の末尾 `/` 付き絶対パス
 *
 * export は test 可能性のため（`clipMatchToCurrentLine` と同じ規律）。
 */
export function resolveRelativePathTarget(
  relPath: string,
  dirPrefix: string,
  cwd: string | undefined,
): PathTarget {
  if (cwd === undefined) return { kind: "worktreeRelative", relPath };
  const absPath = normalizeAbsolute(joinAbsRel(cwd, relPath));
  if (absPath.startsWith(dirPrefix)) {
    return { kind: "worktreeRelative", relPath: absPath.slice(dirPrefix.length) };
  }
  return { kind: "absolute", absPath };
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
