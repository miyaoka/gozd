/**
 * プロジェクトディレクトリから固定長のディレクトリ名を生成する。
 * realpath で symlink を解決し、SHA-256 ハッシュで一意性を保証する。
 * 形式: `<repoName>-<hash>`（例: `gozd-a1b2c3d4e5f6`）
 */
import crypto from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

const HASH_LENGTH = 12;

export function projectKey(projectDir: string): string {
  const realPath = realpathSync(projectDir);
  const hash = crypto.createHash("sha256").update(realPath).digest("hex").slice(0, HASH_LENGTH);
  const name = path.basename(realPath);
  return `${name}-${hash}`;
}
