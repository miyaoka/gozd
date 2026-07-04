// hunk diff の生成 / line counting / 行範囲展開。Swift 版 `GitOps+Diff.swift` の対応物。
// `git diff --no-index` で差分エンジンを git 本体（xdiff、C 実装）に委譲し、結果 unified diff を
// `parseUnifiedDiffHunks` で構造化する。renderer 側 jsdiff 全走査の代替で、pnpm-lock 級でも止まらない。

import { tryCatch } from "@gozd/shared";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitAllowExit1 } from "./gitRunner";

export type DiffHunkLineKind = "context" | "added" | "removed";

interface DiffHunkLineInfo {
  kind: DiffHunkLineKind;
  text: string;
}

export interface DiffHunkInfo {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffHunkLineInfo[];
}

export interface DiffHunksResult {
  hunks: DiffHunkInfo[];
  oldTotalLines: number;
  newTotalLines: number;
}

export interface DiffExpandedLine {
  oldLineNo: number;
  newLineNo: number;
  oldText: string;
  newText: string;
}

/**
 * 2 つのテキスト間の hunk 単位差分と総行数を返す。
 *
 * 設計判断: `git diff --no-index` を使い、差分エンジンを git 本体に委譲する。renderer 側で
 * jsdiff を全文に回すと大ファイルで Myers LCS が O(N×M) に膨れメインスレッドが固まる。
 * 総行数も git の line counting 規約に揃えて返し、trailing バー描画と context 拡張の
 * 絶対座標計算の SSOT を shell 側に置く（renderer 側 split("\n") の二重実装を排除）。
 *
 * ユーザー global config 依存で算法 / 改行扱いが変わると hunk 境界と renderer の line counting
 * がずれるため、依存オプション（algorithm / renames / autocrlf / eol）を明示固定する。
 */
export async function diffHunks(original: string, current: string): Promise<DiffHunksResult> {
  const tmpDir = mkdtempSync(join(tmpdir(), "gozd-diff-"));
  try {
    const aPath = join(tmpDir, "a");
    const bPath = join(tmpDir, "b");
    writeFileSync(aPath, original);
    writeFileSync(bPath, current);

    // exit 0（差分なし）/ 1（差分あり）はどちらも成功
    const output = await runGitAllowExit1(
      [
        "-c", "diff.algorithm=myers",
        "-c", "diff.renames=false",
        "-c", "core.autocrlf=false",
        "-c", "core.eol=lf",
        "diff", "--no-index", "--no-color", "-U3",
        "--", aPath, bPath,
      ],
      tmpDir,
    );

    // `git diff --no-index` は NUL バイトを検知すると hunk を生成せず
    // `Binary files <a> and <b> differ` 行を返す（`diff --git` → `index` → `Binary files` の
    // 3 行構成で hunks と混在しない仕様）。renderer 側で binary 判定をすり抜けた入力が来た
    // 場合の防御線として file header 数行のみ走査して検知する（巨大 output 全体への contains
    // は大ファイル性能改善の目的と矛盾）。silent に hunks=[] を返すと UI 上「差分なし」に
    // 見えるため throw して観察可能化する
    const headerLines = output.split("\n").slice(0, 8);
    if (headerLines.some((line) => line.startsWith("Binary files "))) {
      throw new Error("git diff --no-index reported binary content (renderer pre-filter bypassed)");
    }

    return {
      hunks: parseUnifiedDiffHunks(output),
      oldTotalLines: countDiffLines(original),
      newTotalLines: countDiffLines(current),
    };
  } finally {
    // 削除失敗は累積すると TMPDIR を圧迫するため stderr に observable に出す。
    // throw はしない（diff 結果取得自体は成功している）
    const removed = tryCatch(() => rmSync(tmpDir, { recursive: true, force: true }));
    if (!removed.ok) {
      console.error(`[GitOps] failed to remove diff tmp dir ${tmpDir}: ${removed.error}`);
    }
  }
}

/**
 * git の line counting 規約でテキスト行数を返す。
 * 規約: 空文字 = 0、末尾 `\n` 有り = `\n` 区切りで作られる「終端付き行」の数、
 * 末尾 `\n` 無し = `\n` 区切りの数（最後の `\ No newline at end of file` で参照される行を含む）
 */
export function countDiffLines(text: string): number {
  return splitDiffLines(text).length;
}

/**
 * `countDiffLines` と同じ規約で text を 1 行ずつの配列に分解する。
 * 末尾 `\n` 有りの場合は最後の空要素を除外する（git の line counting に揃える）。
 * 添字は 0-based。1-based の絶対座標から引くときは呼び出し側で `- 1` する
 */
export function splitDiffLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (text.endsWith("\n")) parts.pop();
  return parts;
}

/**
 * hunk-bar クリック展開用に original / current 全文から指定行範囲を切り出す。
 * 1-based。`countDiffLines` と同じ規約で行配列化することで、renderer 側の
 * `text.split("\n").length` との末尾 1 行ずれを起こさない。
 * 範囲外は silent に空文字を返さず throw して observable に倒す
 */
export function expandDiffLines(
  original: string,
  current: string,
  oldStart: number,
  newStart: number,
  lines: number,
): DiffExpandedLine[] {
  if (lines === 0) return [];
  const oldLines = splitDiffLines(original);
  const newLines = splitDiffLines(current);
  const oldEnd = oldStart + lines - 1;
  const newEnd = newStart + lines - 1;
  if (oldStart < 1 || newStart < 1 || oldEnd > oldLines.length || newEnd > newLines.length) {
    throw new Error(
      `expandDiffLines out of range: oldStart=${oldStart} newStart=${newStart} lines=${lines} ` +
        `oldTotal=${oldLines.length} newTotal=${newLines.length}`,
    );
  }
  const result: DiffExpandedLine[] = [];
  for (let k = 0; k < lines; k++) {
    result.push({
      oldLineNo: oldStart + k,
      newLineNo: newStart + k,
      oldText: oldLines[oldStart - 1 + k],
      newText: newLines[newStart - 1 + k],
    });
  }
  return result;
}

/**
 * `git diff --no-index --no-color` 出力専用の unified diff parser。
 *
 * `--no-index` + `-c diff.renames=false` 固定下では file header に出現する行は
 * `diff --git` / `index ` / `--- ` / `+++ ` のみ。汎用 unified diff との両用にすると
 * whitelist がぶれて unexpectedSkips の計上閾値が曖昧になるため `--no-index` 専用と明示する。
 *
 * 各 hunk は `@@ -oldStart[,oldLines] +newStart[,newLines] @@` ヘッダで始まり、
 * ` ` = context / `-` = removed / `+` = added / `\` = no-newline 装飾（読み飛ばす）。
 */
export function parseUnifiedDiffHunks(text: string): DiffHunkInfo[] {
  const hunks: DiffHunkInfo[] = [];
  const lines = text.split("\n");
  // text が `\n` で終わる場合の trailing 空要素は改行終端の正規アーティファクトなので
  // 「想定外行」計上の対象から外す
  if (lines[lines.length - 1] === "") lines.pop();
  // unified diff の想定外行（file header / hunk header / 既知 marker 以外）を skip した件数。
  // 想定通り 0 のはずなので、>0 はパーサと git 出力の乖離として stderr に出す
  let unexpectedSkips = 0;

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    if (!raw.startsWith("@@")) {
      if (
        raw !== "" &&
        !raw.startsWith("diff ") &&
        !raw.startsWith("index ") &&
        !raw.startsWith("--- ") &&
        !raw.startsWith("+++ ")
      ) {
        unexpectedSkips++;
      }
      i++;
      continue;
    }
    const header = parseHunkHeader(raw);
    if (header === undefined) {
      // `@@` で始まるが header 形式に合わない行は parser バグか git 出力の変化
      console.error(`[GitOps] unparseable hunk header: ${raw}`);
      i++;
      continue;
    }
    const hunkLines: DiffHunkLineInfo[] = [];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (
        line.startsWith("@@") ||
        line.startsWith("diff ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ")
      ) {
        break;
      }
      if (line.startsWith("\\")) {
        // `\ No newline at end of file` は装飾、無視
        i++;
        continue;
      }
      const first = line[0];
      const rest = line.slice(1);
      if (first === " ") {
        hunkLines.push({ kind: "context", text: rest });
      } else if (first === "+") {
        hunkLines.push({ kind: "added", text: rest });
      } else if (first === "-") {
        hunkLines.push({ kind: "removed", text: rest });
      } else {
        unexpectedSkips++;
      }
      i++;
    }
    hunks.push({ ...header, lines: hunkLines });
  }
  if (unexpectedSkips > 0) {
    console.error(`[GitOps] parseUnifiedDiffHunks: skipped ${unexpectedSkips} unexpected line(s)`);
  }
  return hunks;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunkHeader(
  line: string,
): Pick<DiffHunkInfo, "oldStart" | "oldLines" | "newStart" | "newLines"> | undefined {
  // 例: "@@ -1,5 +1,7 @@" / "@@ -1 +1 @@" / "@@ -0,0 +1,3 @@ optional ctx"
  const match = HUNK_HEADER_RE.exec(line);
  if (match === null) return undefined;
  return {
    oldStart: Number(match[1]),
    // count 省略時は 1（unified diff 仕様）
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
  };
}
