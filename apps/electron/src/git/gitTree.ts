// commit / tree / file content 系の op。Swift 版 `GitOps+Tree.swift` の対応物。
// `git show` / `git ls-tree` / `git diff <hash>^..<hash>`（commitFiles / prDiffFiles）を扱う。
// root commit を含む range の起点は EMPTY_TREE_HASH を経由して empty tree に倒す
// （root が追加したファイルも diff に含めるため）。

import type { FileReadResult } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { basename } from "node:path";
import { toWireBytes } from "../wireBytes";
import { runGit, runGitBuffer } from "./gitRunner";
import { isAllZeroHex, validateRelPath, validateRev } from "./gitValidate";

export interface FileChangeInfo {
  oldPath: string;
  newPath: string;
  type: string;
}

export interface GitTreeEntryInfo {
  name: string;
  type: string;
}

/** git の well-known empty tree object hash（`git hash-object -t tree </dev/null`）。
 * root commit を range の起点にする際、`<root>` 自身ではなく empty tree を from に置くことで
 * root commit が追加したファイルも diff に含まれる */
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const DIFF_OPTIONS = ["--name-status", "-z", "--find-renames", "--diff-filter=AMDR"];

/**
 * `git show <hash>:<path>` の結果を FileReadResult shape にまとめる。
 * 失敗（exit != 0）= ファイル不在として notFound=true を返す。
 * 想定する失敗: root commit の `^` 解決失敗、未追跡 path、invalid hash。
 * それ以外も silent drop しないよう stderr にログを残して観察可能にする。
 * blob は raw Buffer で読み、NUL byte を含む or UTF-8 decode 失敗はバイナリとして
 * 生 bytes を返す（fsOps.readFileAt と同じ判定規律）。
 */
export async function fileReadResultFromGit(
  dir: string,
  hash: string,
  relPath: string,
): Promise<FileReadResult> {
  const data = await tryCatch(runGitBuffer(["show", `${hash}:${relPath}`], dir));
  if (!data.ok) {
    console.error(`[RpcDispatcher] git show ${hash}:${relPath} failed in ${dir}: ${data.error}`);
    return { content: "", isDirectory: false, notFound: true };
  }
  if (data.value.includes(0x00)) {
    return { content: toWireBytes(data.value), isDirectory: false, notFound: false };
  }
  const decoded = tryCatch(() => new TextDecoder("utf-8", { fatal: true }).decode(data.value));
  if (!decoded.ok) {
    return { content: toWireBytes(data.value), isDirectory: false, notFound: false };
  }
  return { content: decoded.value, isDirectory: false, notFound: false };
}

/**
 * `git rev-parse <hash>:<path>` でファイルの blob OID を返す。
 * hash 自体が解決不能（root の `^` 等）/ path 未追跡なら undefined。
 * from と to の OID が一致すれば「コミット範囲で変更なし」の SSOT 判定として使える。
 * 失敗は undefined 化するが silent drop を避けるため stderr に詳細を残す。
 */
export async function treeFileOID(
  dir: string,
  hash: string,
  relPath: string,
): Promise<string | undefined> {
  const result = await tryCatch(runGit(["rev-parse", `${hash}:${relPath}`], dir));
  if (!result.ok) {
    console.error(`[GitOps] rev-parse ${hash}:${relPath} failed in ${dir}: ${result.error}`);
    return undefined;
  }
  const line = result.value.trim();
  return line === "" ? undefined : line;
}

/**
 * 指定コミットの tree から 1 階層分のエントリを返す。
 *
 * 契約: `path` が空文字なら repo root の 1 階層、それ以外は末尾 `/` を必ず付けて
 * `git ls-tree -z <hash> <path>/` を実行する。末尾 `/` を外すと git はそのエントリ 1 件
 * （tree 自身）を返すため、lazy expand の 1 階層列挙にならない。
 *
 * hash は空文字 / all-zero hex（UNCOMMITTED_HASH）を reject する。snapshot mode は明示的な
 * commit 指定が前提で、git のエラー文言からは「UNCOMMITTED_HASH を流した SSOT 違反」を即診断
 * できないため入口で明示 reject する。
 */
export async function lsTree(dir: string, hash: string, path: string): Promise<GitTreeEntryInfo[]> {
  if (hash === "") throw new Error("git ls-tree: hash must be specified");
  if (isAllZeroHex(hash)) {
    throw new Error("git ls-tree: all-zero hash (UNCOMMITTED_HASH) is not a valid commit");
  }
  validateRev(hash);
  validateRelPath(path);
  const args = ["ls-tree", "-z", hash];
  if (path !== "") {
    args.push(path.endsWith("/") ? path : `${path}/`);
  }
  return parseLsTree(await runGit(args, dir));
}

/**
 * 指定コミット（または範囲指定）の name-status 差分を返す。
 *
 * - 単一コミット非ルート: `git diff <hash>^ <hash>` で first parent との比較。merge commit
 *   でも `hash^` が first parent に解決されるため GitHub の表示と一致する
 *   （`diff-tree -m --first-parent` は先祖の変更が混入するので使わない）
 * - 単一ルートコミット: `git diff-tree --root --no-commit-id -r` を使う（親が無い）
 * - 範囲指定（rangeHashes 非空）: 先頭（newer）と末尾（older）の 2 endpoint で
 *   `git diff <older>^ <newer>` を 1 回実行する。commit ごとの first-parent diff を union する
 *   アプローチは rename chain（foo→bar→baz）や rename 後 delete を解決できず logical file
 *   identity が壊れるため避ける。2 点 diff なら git の rename detection が一発で chain を畳む。
 *   中間 commit で revert された変更が消える点はトレードオフだが、UI 直感（最終状態の差分）と
 *   一致する。older が root commit なら empty tree を起点にする。includeWorkingTree が true
 *   （範囲の片端が Working Tree）は第 2 引数を省略して working tree との比較に切り替える
 */
export async function commitFiles(params: {
  dir: string;
  hash: string;
  rangeHashes: string[];
  includeWorkingTree: boolean;
}): Promise<FileChangeInfo[]> {
  const { dir, hash, rangeHashes, includeWorkingTree } = params;

  const newer = rangeHashes[0];
  const older = rangeHashes[rangeHashes.length - 1];
  if (newer !== undefined && older !== undefined) {
    const from = (await isRootCommit(dir, older)) ? EMPTY_TREE_HASH : `${older}^`;
    const diffArgs = includeWorkingTree
      ? ["diff", ...DIFF_OPTIONS, from]
      : ["diff", ...DIFF_OPTIONS, from, newer];
    return parseDiffNameStatus(await runGit(diffArgs, dir));
  }

  if (await isRootCommit(dir, hash)) {
    return parseDiffNameStatus(
      await runGit(["diff-tree", "--root", "--no-commit-id", "-r", ...DIFF_OPTIONS, hash], dir),
    );
  }
  return parseDiffNameStatus(await runGit(["diff", ...DIFF_OPTIONS, `${hash}^`, hash], dir));
}

/**
 * PR diff（3-dot semantics）: `baseHash` から working tree までの tracked file の
 * name-status 差分を返す。
 *
 * `baseHash` は renderer が `gitMergeBase(HEAD, baseRefOid)` で事前解決した **merge-base OID**
 * であることが契約（= GitHub の Files changed と同じ意味論）。`baseRefOid` を直接渡すと、
 * PR 分岐後に base ブランチが前進した分が逆向きに差分として混入する。untracked の merge は
 * renderer 側（useChangesStore）の責務で、本関数は tracked のみ返す。
 */
export async function prDiffFiles(dir: string, baseHash: string): Promise<FileChangeInfo[]> {
  // validateRev は empty を許す設計のため、commit OID 必須の lsTree / resetMixed と同じ
  // 二段ガードで empty / all-zero を入口で reject する（empty を素通りさせると `git diff` が
  // rev なしの別 semantic で走るため）
  if (baseHash === "") throw new Error("git diff: base hash must be specified");
  if (isAllZeroHex(baseHash)) {
    throw new Error("git diff: all-zero hash (UNCOMMITTED_HASH) is not a valid PR base");
  }
  validateRev(baseHash);
  return parseDiffNameStatus(await runGit(["diff", ...DIFF_OPTIONS, baseHash], dir));
}

/**
 * 与えられた hash がルートコミット（親なし）かどうかを判定する。
 * `git rev-list --parents -n 1 <hash>` は valid な hash であれば必ず exit 0 で
 * `<hash> <parent1>...` の 1 行を返す。トークン数 1 = root。invalid hash は throw を上位に返す
 * （`git rev-parse <hash>^` だと root と invalid hash がどちらも exit 128 で区別できない）
 */
async function isRootCommit(dir: string, hash: string): Promise<boolean> {
  const stdout = await runGit(["rev-list", "--parents", "-n", "1", hash], dir);
  return stdout.trim().split(" ").filter((token) => token !== "").length === 1;
}

/**
 * `git diff` / `git diff-tree` の `--name-status -z` 出力をパースする。
 * フォーマットは両者同一: 通常エントリ `<status>\0<path>\0`、rename/copy
 * `R<score>\0<old>\0<new>\0`（C も同様）
 */
export function parseDiffNameStatus(text: string): FileChangeInfo[] {
  const parts = text.split("\0");
  const result: FileChangeInfo[] = [];
  let i = 0;
  while (i < parts.length) {
    const status = parts[i];
    if (status === "") {
      i++;
      continue;
    }
    const firstChar = status[0];
    if (firstChar === "R" || firstChar === "C") {
      if (i + 2 >= parts.length) break;
      result.push({ oldPath: parts[i + 1], newPath: parts[i + 2], type: firstChar });
      i += 3;
    } else {
      if (i + 1 >= parts.length) break;
      result.push({ oldPath: parts[i + 1], newPath: parts[i + 1], type: firstChar });
      i += 2;
    }
  }
  return result;
}

/**
 * `git ls-tree -z` の NUL 区切り出力を parse する。
 * 各レコード形式: `<mode> SP <type> SP <object> TAB <path>`。`path` 末尾 `/` 付きで呼んだ場合
 * `<path>` は "<parent>/<basename>" になるため basename だけ抽出する。
 * 想定外フォーマットは silent skip せず throw する（silent skip すると「N entries あるはずが
 * N-1 件表示」という不整合が UI 上で観察不能になる）
 */
export function parseLsTree(text: string): GitTreeEntryInfo[] {
  const result: GitTreeEntryInfo[] = [];
  for (const record of text.split("\0")) {
    if (record === "") continue;
    const tabIdx = record.indexOf("\t");
    if (tabIdx < 0) {
      throw new Error(`git ls-tree: record missing TAB separator: ${record}`);
    }
    const header = record.slice(0, tabIdx);
    const fullPath = record.slice(tabIdx + 1);
    const headerParts = header.split(" ");
    if (headerParts.length !== 3) {
      throw new Error(`git ls-tree: header expected 3 SP-delimited fields: ${header}`);
    }
    const name = basename(fullPath);
    if (name === "") {
      throw new Error(`git ls-tree: empty basename in record: ${record}`);
    }
    result.push({ name, type: typeFromGitMode(headerParts[0]) });
  }
  return result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** git ls-tree の mode（`040000` / `120000` / ...）を FileEntry kind の文字列に写像する */
const GIT_MODE_TYPES: Record<string, string> = {
  "040000": "directory",
  "120000": "symlink",
  "160000": "submodule",
};

export function typeFromGitMode(mode: string): string {
  return GIT_MODE_TYPES[mode] ?? "file";
}
