/**
 * プロジェクトディレクトリから NAME_MAX 安全なディレクトリ名を生成する。
 * realpath で symlink を解決し、SHA-256 ハッシュで一意性を保証する。
 * 形式: `<repoName>-<hash>`（例: `gozd-a1b2c3d4e5f6`）
 * repoName は NAME_MAX（255 bytes）に収まるよう UTF-8 バイト数で切り詰める。
 */
import crypto from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

const HASH_LENGTH = 12;
/** APFS（255 UTF-8 文字）/ ext4（255 bytes）の NAME_MAX。安全側として bytes で計測する */
const NAME_MAX_BYTES = 255;
/** ハイフン(1 byte) + ハッシュ(12 bytes, ASCII) */
const SUFFIX_BYTES = 1 + HASH_LENGTH;
const MAX_NAME_BYTES = NAME_MAX_BYTES - SUFFIX_BYTES;

/** UTF-8 バイト数が上限に収まるよう文字列を切り詰める */
export function truncateToBytes(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return str;
  // マルチバイト文字の途中で切れないよう、1文字ずつ確認する
  let byteLen = 0;
  let charEnd = 0;
  for (const char of str) {
    const charBytes = Buffer.byteLength(char, "utf-8");
    if (byteLen + charBytes > maxBytes) break;
    byteLen += charBytes;
    charEnd += char.length;
  }
  return str.slice(0, charEnd);
}

export function projectKey(projectDir: string): string {
  const realPath = realpathSync(projectDir);
  const hash = crypto.createHash("sha256").update(realPath).digest("hex").slice(0, HASH_LENGTH);
  const name = truncateToBytes(path.basename(realPath), MAX_NAME_BYTES);
  return `${name}-${hash}`;
}
