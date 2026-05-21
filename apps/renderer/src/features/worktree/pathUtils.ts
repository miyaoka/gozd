/**
 * パスの種別を kind で分離した選択ターゲット。
 * worktree 内 (filer reveal / git ops が成立) と worktree 外の絶対パス (fsReadFileAbsolute のみ)
 * という非対称性を型で表現する。
 *
 * 表示・選択・link 解決といった複数 feature の SSOT として worktree barrel から export する。
 *
 * 本型と `pathTargetToString` は worktree feature 内の最下層 leaf (`pathUtils.ts`) に置く:
 * store / RPC など上位レイヤーには依存させず、shared / 他 feature からも安全に import できる。
 * 「型・正規化・表示文字列」という純粋な値ドメインだけを集約することで、テスト・SSR を含む
 * あらゆる文脈から副作用なしに参照できる。
 */
export type PathTarget =
  | { kind: "worktreeRelative"; relPath: string }
  | { kind: "absolute"; absPath: string };

/**
 * `PathTarget` の表示用文字列を抽出する純粋関数。
 * ヘッダ表示 / xterm link `text` / log 出力など、kind に関係なく単一の文字列が
 * 必要な箇所で使う SSOT。
 */
export function pathTargetToString(target: PathTarget): string {
  return target.kind === "worktreeRelative" ? target.relPath : target.absPath;
}

/**
 * `PathTarget` の値同一性を判定する純粋関数。
 * Selection 経由の object identity 比較は新規 object literal が毎回作られるため成立しない。
 * 「同じファイルへの再 navigate を no-op に倒す」「履歴に同パス重複を積まない」などで
 * SSOT として使う。kind が異なれば即 false、同じなら path 文字列を比較する。
 */
export function pathTargetEquals(a: PathTarget, b: PathTarget): boolean {
  if (a.kind === "worktreeRelative" && b.kind === "worktreeRelative") {
    return a.relPath === b.relPath;
  }
  if (a.kind === "absolute" && b.kind === "absolute") {
    return a.absPath === b.absPath;
  }
  return false;
}

/**
 * worktree 相対パスの `.` / `..` / 連続スラッシュ / 末尾スラッシュを正規化する。
 * 先頭の `..` は worktree root より上を指すため保持する（呼び出し側で escape 判定）。
 * 引数は相対パスであることを期待する（先頭 `/` 始まりは渡さない契約）。
 *
 * **tilde の扱い (契約)**: `~` で始まる segment は通常の文字として保持する（home 展開しない）。
 * `~/foo` の正規化結果は `~/foo` のまま。home 参照として弾くかどうかは後段の呼び出し側
 * (`resolveMarkdownLink.ts` の `escapesWorktree`) の責務であり、本関数は文字列として
 * 中立に扱う。本契約を変更する場合は `escapesWorktree` の前提が壊れるため同時に直す。
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
