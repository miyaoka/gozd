// git CLI に文字列 (rev / path) を渡す前の入口 validator。Swift 版 `GitValidate.swift` の
// 対応物。git 自身も revision parse で reject するため完全な構文再現は目的にせず、
// option 注入 / sandbox 逸脱 / 制御文字混入の **safety net** として機能することだけを担保する。

const HEX_CHARS = new Set("0123456789abcdefABCDEF");
const REV_ALLOWED_CHARS = new Set("0123456789abcdefABCDEF^~");

/**
 * rev 文字列を git 引数として安全に渡せるか検証する。
 *
 * 許可: 空文字 / "HEAD" / 先頭が 16 進文字で全体が hex + `^` + `~` で構成される文字列。
 * reject: `-` 始まり（option 解釈の余地）/ 非 hex 始まり（`main` 等の named ref）/ hex 外の記号。
 *
 * 本 RPC が想定する rev 計算経路（`""` / `"HEAD"` / `<hash>` / `<hash>^` / `<hash>~N`）に
 * 限定する設計判断: renderer は必ず hash 化してから流す契約のため
 */
export function validateRev(rev: string): void {
  if (rev === "") return;
  if (rev === "HEAD") return;
  if (rev.startsWith("-")) {
    throw new Error(`git rev validation: leading '-' is not allowed: ${rev}`);
  }
  if (!HEX_CHARS.has(rev[0])) {
    throw new Error(`git rev validation: must start with hex digit: ${rev}`);
  }
  for (const char of rev) {
    if (!REV_ALLOWED_CHARS.has(char)) {
      throw new Error(`git rev validation: invalid character in rev: ${rev}`);
    }
  }
}

/** 全 0 hex（`0000000000...`）かどうか。renderer 側の `UNCOMMITTED_HASH` sentinel と一致する。
 * `validateRev` は hex 文字列を通すため、「コミット指定が必須」な RPC 入口で別途明示的に弾く */
export function isAllZeroHex(s: string): boolean {
  if (s === "") return false;
  return /^0+$/.test(s);
}

/**
 * path が worktree 相対パスとして git 引数に渡せるか検証する。
 *
 * 許可: 空文字 / worktree 相対の通常 path。
 * reject: `-` 始まり（option 注入）/ `/` 始まり（絶対パス）/ `..` traversal / 制御文字。
 * renderer は worktree 相対 path を送る契約のため、違反は呼び出し側のバグとして表面化させる
 */
export function validateRelPath(path: string): void {
  if (path === "") return;
  if (path.startsWith("-")) {
    throw new Error(`git path validation: leading '-' is not allowed: ${path}`);
  }
  if (path.startsWith("/")) {
    throw new Error(`git path validation: absolute path is not allowed: ${path}`);
  }
  if (path.split("/").includes("..")) {
    throw new Error(`git path validation: '..' traversal is not allowed: ${path}`);
  }
  for (const char of path) {
    if (char === "\0" || char === "\n" || char === "\r") {
      throw new Error(`git path validation: control character is not allowed: ${path}`);
    }
  }
}
