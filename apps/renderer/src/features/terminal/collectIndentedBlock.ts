import type { IBuffer } from "@xterm/xterm";
import { PATH_TERMINATORS } from "./findAbsolutePathMatches";

/**
 * 継続行ブロックを収集し、[結合テキスト, 現在行の開始オフセット] を返す。
 * ターミナルのハードラップ（isWrapped）と、Claude が長いパスを改行+インデントで
 * 折り返したケースの両方を辿る。
 *
 * 結合の境界規律:
 * - isWrapped: 物理行をまたぐハードラップ。空白は挿入されないのでそのまま連結する
 * - 明示改行+インデント: 継続行の trim 後の先頭文字が区切り文字でない（＝パス文字始まり）の
 *   時のみ連結する。パスは区切り文字で始まらないが、shell コメント(`#`)やコマンドは区切りで
 *   始まる。これにより `.../file.txt` の次に来る `# comment` を誤って連結せず、かつ
 *   `.../very/lo` ⏎ `  ng/file.ts` のようなセグメント途中の折り返しは正しく繋ぐ。
 *
 * オフセット算出を結合と同じ下方向パスで行い、結合条件と offset 計算の二重管理（desync）を防ぐ。
 */
export function collectIndentedBlock(buf: IBuffer, lineIdx: number): [string, number] {
  // 上方向: ブロック先頭を探す。継続条件は下方向と揃える
  let topIdx = lineIdx;
  while (topIdx > 0) {
    const line = buf.getLine(topIdx);
    if (!line) break;
    if (line.isWrapped) {
      topIdx--;
      continue;
    }
    if (!continuesPath(line.translateToString(true))) break;
    topIdx--;
  }

  // 下方向: 結合しつつ、現在行(lineIdx)の開始オフセットを記録する
  let joined = "";
  let currentLineOffset = 0;
  let idx = topIdx;
  let line = buf.getLine(idx);
  while (line) {
    if (idx === lineIdx) currentLineOffset = joined.length;

    if (idx === topIdx || line.isWrapped) {
      // ブロック先頭、またはハードラップ継続はそのまま連結
      joined += line.translateToString(true);
    } else {
      const text = line.translateToString(true);
      // 区切り文字始まりのインデント行（コメント等）はブロック終端
      if (!continuesPath(text)) break;
      joined += text.trimStart();
    }

    idx++;
    line = buf.getLine(idx);
  }

  return [joined, currentLineOffset];
}

/**
 * インデント継続行がパスの折り返しか判定する。継続とみなす条件:
 * - 先頭がインデント（スペース）
 * - trim 後の先頭文字が区切り文字でない（`# comment` のような別トークンを除外）
 * - trim 後が絶対パス root（`/` `~`）で始まらない。`/...` `~/...` は上の行の継続ではなく
 *   単独の絶対パスなので、非パス行（shebang / コメント等）の下に来ても連結しない。
 *   これを許すと上方向ループが非パス行で止まり、その行が下方向で raw 連結されて
 *   boundary が壊れ、パスリンクが消える。
 */
function continuesPath(lineText: string): boolean {
  if (lineText.length === 0 || lineText[0] !== " ") return false;
  const trimmed = lineText.trimStart();
  if (trimmed.length === 0) return false;
  const head = trimmed[0];
  if (head === "/" || head === "~") return false;
  return !PATH_TERMINATORS.test(head);
}
