// ファイルシステム操作 RPC のロジック層。Swift 版 `FSOps.swift` の対応物。
//
// - path は dir からの相対パスとして扱い、判定は `resolveContained` に委譲する
//   （path containment の SSOT は pathContainment.ts）
// - 不在 / ディレクトリは throw ではなく正常応答（notFound / isDirectory）で返す。
//   renderer は削除ノードとして扱い、エラートーストを出さない規律

import type { FileReadResult, FsReadDirEntry, FsReadDirRealTarget } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import type { Dirent } from "node:fs";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { checkIgnore, listGitlinks } from "../git/gitOps";
import { toWireBytes } from "../wireBytes";
import { resolveContained } from "./pathContainment";

interface FsEntry {
  name: string;
  type: FsReadDirEntry["type"];
  /** 実体の在り処（FsReadDirRealTarget の契約） */
  realTarget?: FsReadDirRealTarget;
  /** submodule が指す commit hash（FsReadDirEntry の契約） */
  submoduleHash?: string;
  isIgnored: boolean;
}

/** gitignore 判定前の entry。`isIgnored` は checkIgnore の結果を突き合わせて後から載せる */
type FsEntryDraft = Omit<FsEntry, "isIgnored">;

export interface FsReadDirResult {
  entries: FsEntry[];
  /** ディレクトリ不在（削除済み等）。読み取りエラーとは区別し、正常応答として返す */
  notFound: boolean;
}

export interface FsStatResult {
  exists: boolean;
  type: string;
  size: number;
  modifiedAt: string;
}

const NOT_FOUND_RESULT: FileReadResult = {
  content: "",
  isDirectory: false,
  notFound: true,
};

function resolveSafe(dir: string, path: string): string {
  const resolved = resolveContained(dir, path);
  if (resolved === undefined) throw new Error(`outsideDir: ${path}`);
  return resolved;
}

/** FileReadResult ベースで読み取る。NUL byte を含む or UTF-8 decode 失敗はバイナリとして bytes を返す */
export function readFile(dir: string, path: string): FileReadResult {
  return readFileAt(resolveSafe(dir, path));
}

/** 絶対パスでファイルを読み取る（dir 制約なし）。プレビューで dir 外参照が必要なため */
export function readFileAbsolute(absolutePath: string): FileReadResult {
  return readFileAt(absolutePath);
}

export function writeFile(dir: string, path: string, content: string): void {
  const target = resolveSafe(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** 絶対パスでファイルを書き込む（dir 制約なし）。readFileAbsolute の書き込み対。
 * 非絶対パスは reject する（CWD 基準の silent 解決に倒さない）。読めたファイルの上書き
 * 保存が唯一の経路のため、親ディレクトリは作成しない（不在なら ENOENT で観察可能化）。
 * 同 dir の tmp に書いて rename する atomic write（config.json 等は UI 保存経路が
 * writeFileAtomic で書くため、同一ファイルへの書き込み保証を経路間で揃える） */
export function writeFileAbsolute(absolutePath: string, content: string): void {
  if (!isAbsolute(absolutePath)) throw new Error(`notAbsolutePath: ${absolutePath}`);
  const tmpPath = `${absolutePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, absolutePath);
}

export function stat(dir: string, path: string): FsStatResult {
  const target = resolveSafe(dir, path);
  // Swift 版と同じ組み合わせ: 存在 / directory 判定は symlink を辿り（fileExists 相当）、
  // 種別 / size / mtime は link 自体を見る（attributesOfItem 相当）。dangling symlink は
  // 「辿った先が無い」ため exists: false になる
  const followed = tryCatch(() => statSync(target));
  if (!followed.ok) {
    return { exists: false, type: "", size: 0, modifiedAt: "" };
  }
  const link = lstatSync(target);
  const type = link.isSymbolicLink()
    ? "symlink"
    : followed.value.isDirectory()
      ? "directory"
      : "file";
  return {
    exists: true,
    type,
    size: link.size,
    modifiedAt: link.mtime.toISOString(),
  };
}

export async function readDir(dir: string, path: string): Promise<FsReadDirResult> {
  const target = resolveSafe(dir, path);
  const listed = tryCatch(() => readdirSync(target, { withFileTypes: true }));
  if (!listed.ok) return recheckMissingDir(target, listed.error);
  // 入力 path の表記揺れ（`""` / `"."` / 末尾スラッシュ）を以降へ持ち込まないよう、resolve 済みの
  // target から導出した正規化相対パスだけを使う。同一関数内に入力表記依存の判定を作らないための契約
  const relDir = relative(dir, target);
  // `.git` (directory / gitlink file 両方) はツリーから完全一致で除外する（docs/filer.md）。
  // gitignore 経路とは独立。checkIgnore に渡す前に落とし、無駄な git 呼び出しも省く
  const dirents = listed.value.filter((entry) => entry.name !== ".git");
  // 実体の在り処を判定する基準。dir / 列挙対象それぞれの realpath を 1 回だけ引く。
  // - dirRealPath: relPath（dir 相対）の算出基準
  // - listRealPath: 列挙対象自身が symlink 越しかの判定と、entry の実体パスの基準
  //
  // 列挙成功後でも対象は消え得る（branch 切替 / worktree remove / build 出力の掃除は正常系の
  // event クラス）。readdir 失敗と同じ recheck に合流させ、消えていれば notFound で返す
  const realPaths = tryCatch(() => ({
    dirReal: realpathSync(dir),
    listReal: realpathSync(target),
  }));
  if (!realPaths.ok) return recheckMissingDir(target, realPaths.error);
  const { dirReal: dirRealPath, listReal: listRealPath } = realPaths.value;
  // 列挙対象自身が symlink 越しか（`.claude/skills/x` が link で、その配下を見ている等）。
  // 真なら entry 自身が link でなくても実体はツリー上のパスとは別の場所にある
  const listCrossesLink = listRealPath !== join(dirRealPath, relDir);
  const prefix = relDir === "" ? "" : `${relDir}${sep}`;
  const listing = dirents.map((entry) => {
    const built = buildEntry(entry, listRealPath, dirRealPath, listCrossesLink);
    // gitignore 判定に渡す pathspec は常に **entry 自身**を指す（判定対象は行そのもので、
    // symlink 行ではリンク先ではなく link 自身が git の管理対象）。link 越しの列挙では
    // entry 自身の canonical path を使う: link 越しのパスを渡すと git が
    // `pathspec ... is beyond a symbolic link` で fatal になり、その列挙の全 entry の判定を
    // 落とす（checkIgnore は失敗を空集合に倒す契約）。dir 外は当該 repo の gitignore の
    // 管轄外なので問い合わせ自体を落とす
    const ignoreSpec = listCrossesLink
      ? relPathWithin(join(listRealPath, entry.name), dirRealPath)
      : prefix + entry.name;
    return { built, ignoreSpec };
  });
  // submodule 判定は列挙対象そのものを cwd にして引く（pathspec にディレクトリ名を混ぜず
  // `:(glob)*` 固定に保つための契約。listGitlinks の docstring 参照）。symlink 越しに worktree
  // 外を見ている列挙は当該 repo の index の管轄外なので問い合わせ自体を落とす（ignoreSpec が
  // dir 外を落とすのと同じ規律）。ディレクトリを 1 つも含まない階層に submodule はあり得ないため
  // git を起動しない（working tree の submodule は初期化状態によらずディレクトリとして存在する）
  const needsGitlinks =
    isWithinDir(listRealPath, dirRealPath) && dirents.some((entry) => entry.isDirectory());
  const [ignored, gitlinks] = await Promise.all([
    checkIgnore(
      dir,
      listing.flatMap(({ ignoreSpec }) => (ignoreSpec === undefined ? [] : [ignoreSpec])),
    ),
    needsGitlinks ? listGitlinks(listRealPath) : new Map<string, string>(),
  ]);
  const entries = listing
    .map(({ built, ignoreSpec }) => ({
      ...applyGitlink(built, gitlinks),
      isIgnored: ignoreSpec !== undefined && ignored.has(ignoreSpec),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { entries, notFound: false };
}

/**
 * 列挙経路の失敗を「削除済みノード」と「真の読み取りエラー」に振り分ける判定の SSOT。
 *
 * 対象がディレクトリとして存在するかを **失敗後に** 再確認する。事前チェックではなく失敗後 recheck に
 * することで、存在チェックと操作の隙に削除される TOCTOU race を避ける。分岐は 3 つ:
 *
 * - 再確認が成功してディレクトリでない: 同名ファイルへ置換された削除済みノードとして notFound
 * - 再確認が成功してディレクトリのまま: 真の読み取りエラー (permission 等) なので rethrow して 500
 * - 再確認自体が失敗: 辿れない系 (削除 / 循環 / 非ディレクトリ化) なら notFound、それ以外
 *   (permission 等) は rethrow。notFound に倒すと権限の問題が「削除された」として UI に出て原因が消える
 */
function recheckMissingDir(target: string, error: unknown): FsReadDirResult {
  const recheck = tryCatch(() => statSync(target));
  if (recheck.ok) {
    if (recheck.value.isDirectory()) throw error;
    return { entries: [], notFound: true };
  }
  // recheck 自身の失敗も分類する。辿れない系 (削除 / 循環 / 非ディレクトリ化) 以外
  // (permission 等) を notFound に倒すと、権限の問題が「削除された」として UI に出て
  // 元の error も消える
  if (!isUntraversable(recheck.error)) throw error;
  return { entries: [], notFound: true };
}

/**
 * dirent 1 件を entry（name / type / realTarget）に組み立てる。
 *
 * symlink は lstat 由来の種別 ("symlink") を保ったまま、辿った結果を realTarget に載せる。
 * これが無いと renderer は dir symlink を leaf に潰すしかない。辿れない link は realTarget 不在で
 * 「実体なし」を表現する（分類は resolveRealTarget）。
 *
 * 非 symlink の entry は `listRealPath` が canonical であることから実体パスが確定するため、
 * realpath / stat を引き直さない（entry 数ぶんの syscall を避けるだけでなく、readdir と stat の
 * 隙に entry が消えて realTarget だけ静かに落ちる失敗経路も作らない）。
 */
function buildEntry(
  entry: Dirent,
  listRealPath: string,
  dirRealPath: string,
  listCrossesLink: boolean,
): FsEntryDraft {
  if (entry.isSymbolicLink()) {
    return {
      name: entry.name,
      type: "symlink",
      realTarget: resolveRealTarget(join(listRealPath, entry.name), dirRealPath),
    };
  }
  const isDirectory = entry.isDirectory();
  const type = isDirectory ? "directory" : "file";
  if (!listCrossesLink) return { name: entry.name, type };
  return {
    name: entry.name,
    type,
    realTarget: toRealTarget(join(listRealPath, entry.name), isDirectory, dirRealPath),
  };
}

/**
 * index の gitlink と突き合わせて、ディレクトリとして列挙された entry を submodule に倒す。
 *
 * 対象を directory に限るのは、gitlink の path が working tree では file / symlink になっている
 * 食い違い状態を submodule として描かないため。ディスク上の実体の種別は常に lstat が SSOT で、
 * index は「その実体が submodule として登録されているか」だけを足す。
 */
function applyGitlink(entry: FsEntryDraft, gitlinks: Map<string, string>): FsEntryDraft {
  if (entry.type !== "directory") return entry;
  const submoduleHash = gitlinks.get(entry.name);
  if (submoduleHash === undefined) return entry;
  return { ...entry, type: "submodule", submoduleHash };
}

/**
 * symlink を辿って実体の在り処を返す。辿れない場合は undefined。
 *
 * dangling (ENOENT) / 循環 (ELOOP) / 中間成分が非ディレクトリ (ENOTDIR) は symlink の正常な
 * 壊れ方で、renderer も `realTarget` 不在を「実体なし」として表示に使うため無音で返す。それ以外
 * (permission 等) は「実体なし」と区別が付かないまま握り潰されると link 行が壊れて見える原因を
 * 追えなくなるので観察ログを残す。
 */
function resolveRealTarget(linkPath: string, dirRealPath: string): FsReadDirRealTarget | undefined {
  const resolved = tryCatch(() => realpathSync(linkPath));
  if (!resolved.ok) {
    logUnresolvedLink(linkPath, undefined, resolved.error);
    return undefined;
  }
  const followed = tryCatch(() => statSync(resolved.value));
  if (!followed.ok) {
    logUnresolvedLink(linkPath, resolved.value, followed.error);
    return undefined;
  }
  return toRealTarget(resolved.value, followed.value.isDirectory(), dirRealPath);
}

/** 実体を解決できなかった失敗のうち、symlink の正常な壊れ方でないものだけ観察ログに残す。
 * 発生源の行を特定できるよう link 自身の path を常に出す */
function logUnresolvedLink(
  linkPath: string,
  resolvedPath: string | undefined,
  error: unknown,
): void {
  if (isUntraversable(error)) return;
  console.error(
    `[resolveRealTarget] resolve failed path=${linkPath} resolved=${resolvedPath ?? "(unresolved)"} error=${String(error)}`,
  );
}

/**
 * path を辿れない系の失敗か。UI は「実体なし」/「削除ノード」で表現できるので、無音で扱ってよい
 * 集合の SSOT にする（readDir の recheck と link 解決で集合が割れると、同じ壊れた link が経路に
 * よってトーストと無音に分かれる）。非 Error が throw されても壊れない。
 */
function isUntraversable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR";
}

/**
 * 解決済みの実体パスから realTarget を組み立てる。
 *
 * `relPath` の包含判定は realpath 同士で行う。`dirRealPath` を使わず入力の dir で比較すると、
 * dir 自身が symlink 経由のパス（macOS の `$TMPDIR` 等）のときに「実体は dir 配下なのに外部扱い」
 * になり、renderer が worktree 相対で開ける実体を absolute へ倒してしまう。
 */
function toRealTarget(
  absPath: string,
  isDirectory: boolean,
  dirRealPath: string,
): FsReadDirRealTarget {
  return {
    type: isDirectory ? "directory" : "file",
    absPath,
    relPath: relPathWithin(absPath, dirRealPath),
  };
}

/** realpath 済みの絶対パスが dir 配下（dir 自身を含む）にあるか。`relPathWithin` は dir 自身に
 * 相対パスを与えられないため、包含だけを問う判定はこちらに分ける */
function isWithinDir(absPath: string, dirRealPath: string): boolean {
  return absPath === dirRealPath || relPathWithin(absPath, dirRealPath) !== undefined;
}

/** realpath 済みの絶対パスが dir 配下なら dir 相対パスを返す。dir 外なら undefined */
function relPathWithin(absPath: string, dirRealPath: string): string | undefined {
  const prefix = dirRealPath.endsWith(sep) ? dirRealPath : `${dirRealPath}${sep}`;
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : undefined;
}

/** 共通の file 読み取り処理。directory / not-found / binary 検出を一括で扱う */
function readFileAt(absolutePath: string): FileReadResult {
  const followed = tryCatch(() => statSync(absolutePath));
  if (!followed.ok) return NOT_FOUND_RESULT;
  if (followed.value.isDirectory()) {
    return { content: "", isDirectory: true, notFound: false };
  }
  const data = tryCatch(() => readFileSync(absolutePath));
  if (!data.ok) return NOT_FOUND_RESULT;
  // NUL byte を含む or UTF-8 decode 失敗でバイナリ判定し、生 bytes を返す
  if (data.value.includes(0x00)) {
    return { content: toWireBytes(data.value), isDirectory: false, notFound: false };
  }
  const decoded = tryCatch(() => new TextDecoder("utf-8", { fatal: true }).decode(data.value));
  if (!decoded.ok) {
    return { content: toWireBytes(data.value), isDirectory: false, notFound: false };
  }
  return { content: decoded.value, isDirectory: false, notFound: false };
}
