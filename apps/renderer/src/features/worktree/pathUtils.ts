/**
 * パス中の `.` と `..` を解決し、連続スラッシュ・末尾スラッシュを除去する。
 * 絶対パスではルートを越える `..` を無視し、相対パスでは先頭の `..` を保持する。
 */
function normalizePath(path: string): string {
  const isAbsolute = path.startsWith("/");
  const isTilde = path.startsWith("~/");

  const segments = path.split("/").filter((s) => s !== "");
  const result: string[] = [];

  // ~ プレフィックスはセグメントから除外して後で復元する
  const startIdx = isTilde ? 1 : 0;

  for (let i = startIdx; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg === ".") continue;
    if (seg === "..") {
      if (result.length > 0 && result[result.length - 1] !== "..") {
        result.pop();
      } else if (!isAbsolute && !isTilde) {
        // 相対パスでは先頭の .. を保持
        result.push("..");
      }
      continue;
    }
    result.push(seg);
  }

  const joined = result.join("/");
  if (isTilde) return `~/${joined}`;
  if (isAbsolute) return `/${joined}`;
  return joined;
}

export { normalizePath };
