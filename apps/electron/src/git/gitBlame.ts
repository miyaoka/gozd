// blame と blame-anchored log（logLine）。Swift 版 `GitOps+Blame.swift` の対応物。
// 前者は `git blame --porcelain` の 1 行 spawn、後者は `git log -L<n>,<n>:<path>` で
// 1 行の変更履歴を walk する。両者とも LOG_FORMAT / parseLogRecords SSOT（gitLog.ts）を共有する。

import { tryCatch } from "@gozd/shared";
import { statSync } from "node:fs";
import { join } from "node:path";
import { LOG_FORMAT, parseLogRecords, type CommitInfo } from "./gitLog";
import { GitCommandError, runGit } from "./gitRunner";
import { validateRev } from "./gitValidate";

/** blame 対象ファイルのサイズ上限。これを超えると blame は秒オーダーでブロックするため
 * 早期に reject する。閾値は GitHub の blame UI のハード上限と同等の目安 */
const BLAME_MAX_BLOB_BYTES = 2 * 1024 * 1024;

export interface BlameLineInfo {
  hash: string;
  shortHash: string;
  author: string;
  authorMail: string;
  authorTime: number;
  summary: string;
  sourceLine: number;
  notCommitted: boolean;
}

/**
 * 単一行の blame 結果。`git blame --porcelain -L <line>,<line> [<rev>] -- <relPath>` を
 * 1 行ぶんに絞ってヘッダ + メタ行のみを parse する。
 *
 * rev が空文字なら rev を渡さず working tree を blame。working tree の未コミット行は
 * porcelain ヘッダの sha が全 0 で返るため notCommitted フラグに倒す。
 *
 * `--incremental` を使わない理由: 1 行 RPC 用途では出力は数行で、`--porcelain` の方が
 * すべてのメタ行が必ず付随する保証があり parse 規約が簡単。
 *
 * 大ファイル保護: blame は出力が 1 行でも対象ファイル全体を walk するため、pnpm-lock 級
 * （数 MB）のファイルでブロックする。blob サイズを先に測り上限超過を reject する。
 */
export async function blameLine(params: {
  dir: string;
  relPath: string;
  rev: string;
  line: number;
}): Promise<BlameLineInfo> {
  const { dir, relPath, rev, line } = params;
  validateRev(rev);
  await ensureBlameableSize(dir, rev, relPath);
  const args = ["blame", "--porcelain", "-L", `${line},${line}`];
  if (rev !== "") args.push(rev);
  args.push("--", relPath);
  const text = await runGit(args, dir);

  let hash = "";
  let sourceLine = line;
  let author = "";
  let authorMail = "";
  let authorTime = 0;
  let summary = "";
  let headerSeen = false;
  for (const rawLine of text.split("\n")) {
    if (rawLine.startsWith("\t")) {
      // ソース行本体。--porcelain は 1 回だけ出力する。以降のメタ行はないので break。
      // trim 前の文字を見ないと先頭タブが落ちて誤判定する
      break;
    }
    // CRLF 等の trailing whitespace で数値 parse が失敗して authorTime が 0 に倒れるのを防ぐ
    const s = rawLine.trim();
    if (!headerSeen) {
      // 最初の非タブ行はヘッダ: "<sha> <orig_line> <final_line> [<group_size>]"
      const parts = s.split(" ").filter((part) => part !== "");
      if (parts.length >= 3) {
        hash = parts[0];
        const n = Number(parts[1]);
        if (Number.isInteger(n)) sourceLine = n;
      }
      headerSeen = true;
      continue;
    }
    if (s.startsWith("author ")) {
      author = s.slice("author ".length);
    } else if (s.startsWith("author-mail ")) {
      // `<email>` 形式で囲まれる。<> を剥がして mailto-friendly に
      const raw = s.slice("author-mail ".length);
      authorMail = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
    } else if (s.startsWith("author-time ")) {
      const n = Number(s.slice("author-time ".length));
      if (Number.isInteger(n)) authorTime = n;
    } else if (s.startsWith("summary ")) {
      summary = s.slice("summary ".length);
    }
  }

  if (hash === "") {
    throw new Error("git blame: missing porcelain header");
  }
  const notCommitted = [...hash].every((char) => char === "0");
  return {
    hash,
    shortHash: hash.slice(0, 7),
    author,
    authorMail,
    authorTime,
    summary,
    sourceLine,
    notCommitted,
  };
}

/**
 * 単一行の変更履歴。`git log -L<line>,<line>:<relPath> --no-patch <rev>` 相当。
 *
 * `--no-patch` で diff 本体を抑制し、LOG_FORMAT で commit metadata のみ取り出す。
 * parse は parseLogRecords SSOT を経由し strict 契約を共有する。
 *
 * path に `:` を含む場合は `-L<n>,<n>:<path>` の syntax が壊れるため reject。
 * rev は空文字も reject する: 本 RPC は呼び出し側（useBlamePopover）が必ず blame した
 * commit hash を起点として流す契約で、rev="" で HEAD 起点 walk に倒れると「blame した
 * commit を含まない history」が返って意味契約が壊れる。
 */
export async function logLine(params: {
  dir: string;
  relPath: string;
  rev: string;
  line: number;
  maxCount: number;
}): Promise<CommitInfo[]> {
  const { dir, relPath, rev, line, maxCount } = params;
  if (rev === "") {
    throw new Error(
      "git log -L: rev must be specified (empty rev would walk HEAD and break the blame-anchored contract)",
    );
  }
  validateRev(rev);
  if (relPath.includes(":")) {
    // `-L<n>,<n>:<path>` は `:` を separator として使うため、path に `:` を含むと
    // 正しく parse されない。仕様上の制約のため明示 reject
    throw new Error("git log -L: path contains ':', which is unsupported");
  }
  const args = [
    "log",
    `--format=${LOG_FORMAT}`,
    "--decorate=short",
    "--no-patch",
    "-L",
    `${line},${line}:${relPath}`,
  ];
  if (maxCount > 0) args.push(`--max-count=${maxCount}`);
  args.push(rev);
  return parseLogRecords(await runGit(args, dir));
}

/**
 * ファイル全体の変更履歴。`git log --format=<LOG_FORMAT> --no-patch <rev> -- <relPath>` 相当。
 *
 * logLine（行単位）との違いは、pathspec（`-- <relPath>`）でファイル全体を walk する点と、
 * **rev に空文字を許容** する点。空文字は rev を渡さず HEAD walk に倒れ「そのファイルの
 * 最新コミット」起点になる。blame-anchored 契約はファイル history には無いため許す。
 * pathspec は `--` で分離するため logLine のような `:` reject は不要。
 */
export async function logFile(params: {
  dir: string;
  relPath: string;
  rev: string;
  maxCount: number;
}): Promise<CommitInfo[]> {
  const { dir, relPath, rev, maxCount } = params;
  validateRev(rev);
  const args = ["log", `--format=${LOG_FORMAT}`, "--decorate=short", "--no-patch"];
  if (maxCount > 0) args.push(`--max-count=${maxCount}`);
  if (rev !== "") args.push(rev);
  args.push("--", relPath);
  return parseLogRecords(await runGit(args, dir));
}

/**
 * rev 指定時のサイズチェック helper。rev 指定時は `git cat-file -s <rev>:<relPath>`、
 * working tree（rev=""）なら fs stat。
 *
 * 観察可能性: silent fallback は **想定された「存在しない」経路のみ** に限定する。
 * - working tree: file-not-found（ENOENT）のみ silent 通過。blame は同条件で git の
 *   「no such path」エラーに倒れて RPC error として表面化する
 * - rev 指定: `git cat-file -s` の GitCommandError（path 未解決 / 不正 rev）のみ silent 通過。
 *   spawn 失敗 / 非数値 stdout は throw して観察可能化する
 */
async function ensureBlameableSize(dir: string, rev: string, relPath: string): Promise<void> {
  let bytes: number;
  if (rev === "") {
    const stat = tryCatch(() => statSync(join(dir, relPath)));
    if (!stat.ok) {
      const error = stat.error as NodeJS.ErrnoException;
      if (error.code === "ENOENT") return;
      throw stat.error;
    }
    bytes = stat.value.size;
  } else {
    const result = await tryCatch(runGit(["cat-file", "-s", `${rev}:${relPath}`], dir));
    if (!result.ok) {
      // exit code != 0: root commit の `^` / 未追跡 path / invalid rev 等のみ silent 通過。
      // blame 側でも同 rev:path が解決失敗するため RPC error として一貫した経路で表面化する
      if (result.error instanceof GitCommandError) return;
      throw result.error;
    }
    const s = result.value.trim();
    const parsed = Number(s);
    // exit 0 で stdout が非数値（repo 破損 / 想定外フォーマット）を 0 化すると size gate を
    // 素通りして blame に進んでしまうため throw に倒す（fallback せずエラーにする規約）
    if (!Number.isInteger(parsed)) {
      throw new Error(`git cat-file -s returned unparseable size: ${s}`);
    }
    bytes = parsed;
  }
  if (bytes > BLAME_MAX_BLOB_BYTES) {
    throw new Error(`git blame: file too large (${bytes} bytes > ${BLAME_MAX_BLOB_BYTES})`);
  }
}
