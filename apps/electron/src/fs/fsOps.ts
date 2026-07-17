// ファイルシステム操作 RPC のロジック層。Swift 版 `FSOps.swift` の対応物。
//
// - path は dir からの相対パスとして扱い、判定は `resolveContained` に委譲する
//   （path containment の SSOT は pathContainment.ts）
// - 不在 / ディレクトリは throw ではなく正常応答（notFound / isDirectory）で返す。
//   renderer は削除ノードとして扱い、エラートーストを出さない規律

import type { FileReadResult } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { checkIgnore } from "../git/gitOps";
import { toWireBytes } from "../wireBytes";
import { resolveContained } from "./pathContainment";

interface FsEntry {
  name: string;
  type: string;
  isIgnored: boolean;
}

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
 * 保存が唯一の経路のため、親ディレクトリは作成しない（不在なら ENOENT で観察可能化） */
export function writeFileAbsolute(absolutePath: string, content: string): void {
  if (!isAbsolute(absolutePath)) throw new Error(`notAbsolutePath: ${absolutePath}`);
  writeFileSync(absolutePath, content);
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
  if (!listed.ok) {
    // 列挙に失敗。対象がディレクトリとして存在するか「失敗後」に再確認する。
    // 不在 (ENOENT) / ディレクトリでなくなった (ENOTDIR: 削除後に同名ファイルへ置換) なら
    // 削除済みノードとして notFound を返す。事前チェックではなく失敗後 recheck にすることで、
    // 存在チェックと列挙の隙に削除される TOCTOU race を避ける。存在するディレクトリでの失敗
    // (permission 等) は真の読み取りエラーなので rethrow して 500 にする
    const recheck = tryCatch(() => statSync(target));
    if (!recheck.ok || !recheck.value.isDirectory()) {
      return { entries: [], notFound: true };
    }
    throw listed.error;
  }
  // `.git` (directory / gitlink file 両方) はツリーから完全一致で除外する（docs/filer.md）。
  // gitignore 経路とは独立。checkIgnore に渡す前に落とし、無駄な git 呼び出しも省く
  const dirents = listed.value.filter((entry) => entry.name !== ".git");
  const typed = dirents.map((entry) => {
    const type = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file";
    return { name: entry.name, type };
  });
  // gitignore 判定は dir（worktree root）からの相対パスで行う
  const prefix = path === "" ? "" : path.endsWith("/") ? path : `${path}/`;
  const ignored = await checkIgnore(
    dir,
    typed.map((entry) => prefix + entry.name),
  );
  const entries = typed
    .map((entry) => ({ ...entry, isIgnored: ignored.has(prefix + entry.name) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { entries, notFound: false };
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
