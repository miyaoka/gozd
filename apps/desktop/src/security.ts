import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { tryCatch } from "@gozd/shared";
import type { FileReadResult } from "@gozd/rpc";

const ALLOWED_PROTOCOLS = new Set(["https:", "http:"]);

export function isAllowedProtocol(raw: string): boolean {
  const result = tryCatch(() => new URL(raw));
  if (!result.ok) return false;
  return ALLOWED_PROTOCOLS.has(result.value.protocol);
}

/** ファイル内容を読み取る（バイナリ判定・サイズ制限付き） */
export async function readFileContent(absolutePath: string): Promise<FileReadResult> {
  const file = Bun.file(absolutePath);
  const exists = await file.exists();
  if (!exists) {
    // 非存在: ディレクトリかパスが存在しないか判定
    const stat = tryCatch(() => fs.statSync(absolutePath));
    if (stat.ok && stat.value.isDirectory()) {
      return { content: "", isBinary: false, isDirectory: true };
    }
    return { content: "", isBinary: false, notFound: true };
  }
  const MAX_FILE_SIZE = 1024 * 1024; // 1MB
  if (file.size > MAX_FILE_SIZE) {
    return { content: "", isBinary: true };
  }
  // NUL バイトの有無でバイナリ判定（git と同じ方式）
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.includes(0x00)) {
    return { content: "", isBinary: true };
  }
  const content = new TextDecoder().decode(bytes);
  return { content, isBinary: false };
}

/** path.relative() の結果が root の外を指すかを判定する */
function isPathOutside(relative: string): boolean {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/** Git 論理パスの検証。realpath は使わない（git は repo 内の論理パスで操作するため） */
export function resolveGitPath(root: string, relPath: string): string {
  const resolved = path.resolve(root, relPath);
  const relative = path.relative(root, resolved);
  if (!relative || isPathOutside(relative)) {
    throw new Error("Access denied: path is outside workspace root");
  }
  return resolved;
}

/** 既存 FS パスの検証。realpath で symlink を解決し、実パスが root 配下であることを確認する */
export async function resolveExistingFsPath(root: string, relPath: string): Promise<string> {
  const resolved = path.resolve(root, relPath);
  const real = await fsp.realpath(resolved);
  const realRoot = await fsp.realpath(root);
  const relative = path.relative(realRoot, real);
  if (isPathOutside(relative)) {
    throw new Error("Access denied: path is outside workspace root");
  }
  return real;
}

/** 未存在 FS パスの検証。親ディレクトリを realpath で検証し、作成先が root 配下であることを確認する */
export async function resolveCreatableFsPath(root: string, relPath: string): Promise<string> {
  const resolved = path.resolve(root, relPath);
  const parent = path.dirname(resolved);
  const realParent = await fsp.realpath(parent);
  const realRoot = await fsp.realpath(root);
  const parentRelative = path.relative(realRoot, realParent);
  if (isPathOutside(parentRelative)) {
    throw new Error("Access denied: path is outside workspace root");
  }
  // 親の実パスを基準にファイル名を結合して返す
  return path.join(realParent, path.basename(resolved));
}
