// rg を spawn して全文検索を実行し、マッチを push で逐次配信する。
// VS Code `RipgrepTextSearchEngine` + `RipgrepParser` を gozd の push モデルに移植したもの。
//
// - handler が受け取る `push`（rpcDispatcher の PushFn）で `textSearchMatch` を逐次発射する
// - request の Promise は rg プロセス終了で resolve し、`limitHit` を終端信号として返す
// - 進行中の検索は searchId で引ける running レジストリに載せ、cancel で kill する
//
// 設計上の制約: 単一行マッチのみ扱う（--multiline 非対応）。列は byte offset を
// UTF-8 デコードして文字数に変換する。

import type {
  TextSearchLineResult,
  TextSearchMatchPush,
  TextSearchRequest,
  TextSearchResponse,
} from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { PushFn } from "../rpcDispatcher";
import { DEFAULT_MAX_RESULTS, getRgArgs } from "./rgArgs";
import { rgDiskPath } from "./rgPath";

/** 1 push にまとめる行数。IPC を溢れさせない coarse batching。 */
const BATCH_SIZE = 100;

/** 1 行テキストの転送上限（文字数）。commit 済み minified の 1 行数 MB を IPC / 蓄積に
 *  流さないためのキャップ（VS Code の preview 長キャップ相当）。超過分は切り詰める。 */
const MAX_LINE_TEXT = 1000;

/** 進行中の rg プロセス。cancel が searchId で引いて kill する。 */
const running = new Map<string, ChildProcess>();

/** rg の bytes/text 両表現。非 UTF-8 行は base64 の bytes で来る。 */
interface RgBytesOrText {
  text?: string;
  bytes?: string;
}

interface RgSubmatch {
  match: RgBytesOrText;
  start: number;
  end: number;
}

interface RgMatchData {
  path: RgBytesOrText;
  lines: RgBytesOrText;
  line_number: number;
  submatches: RgSubmatch[];
}

interface RgMessage {
  type: string;
  data: RgMatchData;
}

function decode(value: RgBytesOrText): string {
  if (value.bytes !== undefined) return Buffer.from(value.bytes, "base64").toString("utf8");
  return value.text ?? "";
}

function toLineResult(data: RgMatchData, isContext: boolean): TextSearchLineResult {
  // 検索対象を "." で渡すため rg は "./a.ts" 形で返す。dir 相対に正規化する
  const path = decode(data.path).replace(/^\.\//, "");
  const fullText = decode(data.lines);
  const fullBytes = Buffer.from(fullText, "utf8");
  const text = fullText.replace(/\r?\n$/, "");
  const line = data.line_number - 1;

  // submatch の start/end は行内の byte offset。文字列列に直すため prefix をデコードして数える
  const ranges = isContext
    ? []
    : data.submatches.map((submatch) => ({
        startColumn: fullBytes.subarray(0, submatch.start).toString("utf8").length,
        endColumn: fullBytes.subarray(0, submatch.end).toString("utf8").length,
      }));

  // 長大行（minified 等）は転送前に切り詰め、cap 外に出るマッチ範囲は捨て / クランプする
  if (text.length > MAX_LINE_TEXT) {
    const clippedRanges = ranges
      .filter((range) => range.startColumn < MAX_LINE_TEXT)
      .map((range) => ({
        startColumn: range.startColumn,
        endColumn: Math.min(range.endColumn, MAX_LINE_TEXT),
      }));
    return { path, line, text: text.slice(0, MAX_LINE_TEXT), ranges: clippedRanges, isContext };
  }

  return { path, line, text, ranges, isContext };
}

export function searchText(req: TextSearchRequest, push: PushFn): Promise<TextSearchResponse> {
  const { searchId, dir, query, options = {} } = req;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const args = getRgArgs(query, options);

  return new Promise((resolve) => {
    const child = spawn(rgDiskPath(), args, { cwd: dir });
    running.set(searchId, child);

    const decoder = new StringDecoder("utf8");
    let remainder = "";
    let numResults = 0;
    let limitHit = false;
    let batch: TextSearchLineResult[] = [];

    const flush = (): void => {
      if (batch.length === 0) return;
      push("textSearchMatch", { searchId, dir, lines: batch } satisfies TextSearchMatchPush);
      batch = [];
    };

    const finish = (): void => {
      running.delete(searchId);
      flush();
      resolve({ searchId, limitHit } satisfies TextSearchResponse);
    };

    const handleLine = (line: string): void => {
      if (line === "" || limitHit) return;
      const parsed = tryCatch(() => JSON.parse(line) as RgMessage);
      if (!parsed.ok) {
        // rg --json が想定外の出力を返した場合の切り分け用（silent drop 禁止）
        console.error(
          `[searchText] malformed rg json line: ${line.slice(0, 200)} searchId=${searchId}`,
        );
        return;
      }
      const { type, data } = parsed.value;
      // match / context 以外（summary / begin / end）は無視する
      if (type !== "match" && type !== "context") return;

      const result = toLineResult(data, type === "context");
      // context 行は上限に数えない（マッチ範囲のみカウント）
      numResults += result.ranges.length;
      batch.push(result);
      if (batch.length >= BATCH_SIZE) flush();

      if (numResults >= maxResults) {
        limitHit = true;
        child.kill();
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = remainder + decoder.write(chunk);
      const lines = text.split("\n");
      remainder = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      console.error(
        `[searchText] rg stderr: ${chunk.toString("utf8").slice(0, 500)} searchId=${searchId}`,
      );
    });

    // spawn 失敗（ENOENT 等）は silent drop せず観察ログを残して終端させる
    child.on("error", (error) => {
      console.error(`[searchText] rg spawn failed: ${error} searchId=${searchId} dir=${dir}`);
      finish();
    });

    child.on("close", () => {
      if (remainder !== "") handleLine(remainder);
      finish();
    });
  });
}

/** 進行中の検索を kill する。動いていて kill したら true、既に終了/不在なら false。 */
export function cancelSearch(searchId: string): boolean {
  const child = running.get(searchId);
  if (child === undefined) return false;
  child.kill();
  running.delete(searchId);
  return true;
}
