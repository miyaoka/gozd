/**
 * worktree 相対パスの `.` / `..` / 連続スラッシュ / 末尾スラッシュを正規化する。
 * 先頭の `..` は worktree root より上を指すため保持する（呼び出し側で escape 判定）。
 * 引数は相対パスであることを期待する（先頭 `/` 始まりは渡さない契約）。
 */
function normalizeRelative(relPath: string): string {
  const segments = relPath.split("/").filter((s) => s !== "");
  const result: string[] = [];

  for (const seg of segments) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (result.length > 0 && result[result.length - 1] !== "..") {
        result.pop();
      } else {
        result.push("..");
      }
      continue;
    }
    result.push(seg);
  }

  return result.join("/");
}

/**
 * 絶対パスの `.` / `..` / 連続スラッシュ / 末尾スラッシュを正規化する。
 * ルートを越える `..` は無視し、ルート (`/`) で停まる。
 * 引数は `/` 始まりの絶対パスであることを期待する。
 */
function normalizeAbsolute(absPath: string): string {
  const segments = absPath.split("/").filter((s) => s !== "");
  const result: string[] = [];

  for (const seg of segments) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (result.length > 0) result.pop();
      continue;
    }
    result.push(seg);
  }

  return `/${result.join("/")}`;
}

export { normalizeAbsolute, normalizeRelative };
