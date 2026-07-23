// 「files to include / exclude」入力欄のテキストを rg に渡す glob 配列へ正規化する。
// VS Code の queryBuilder（parseSearchPaths + expandGlobalGlob）を移植したもの。
//
// 各パターンを 2 形に展開する:
//   pattern → ["**/" + pattern + "/**",  "**/" + pattern]
// 前者はそのディレクトリ配下すべて、後者はその名前のファイル / エントリ自体にマッチする。
// どちらも "**" 始まりになるため、getRgArgs の doubleStar 分岐（!* を付けず直接 -g）に入り、
// nested なディレクトリ（例 apps/studio-app）でも descent できる。生の "**/foo/**" 単体では
// rg が root で止まって 0 件になる問題（!* 併用時）を、この二分岐設計で構造的に回避している。
//
// 前処理（VS Code parseSearchPaths と同じ）:
//   - 末尾のスラッシュを除去（"src/" → "src"）
//   - 先頭ドットは "*" を前置（".ts" → "*.ts"。拡張子指定を glob 化する）

/** パターンを [配下用, エントリ自体用] の 2 glob へ展開する（VS Code expandGlobalGlob）。 */
function expandGlobalGlob(pattern: string): string[] {
  return [`**/${pattern}/**`, `**/${pattern}`].map((p) => p.replaceAll("**/**", "**"));
}

export function expandFilterGlobs(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .flatMap((raw) => {
      // 末尾スラッシュ除去 + 先頭ドット補正
      let pattern = raw.replace(/[/\\]+$/, "");
      if (pattern.startsWith(".")) pattern = `*${pattern}`;
      return expandGlobalGlob(pattern);
    });
}
