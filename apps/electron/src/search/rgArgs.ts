// rg の引数組み立て。VS Code `ripgrepTextSearchEngine.ts` の getRgArgs を macOS 前提に
// 削ったもの（CRLF 補正・brace 展開・マルチプラットフォーム分岐は不要）。
//
// 出力形式は常に `--json`（1 マッチ = 1 JSON 行）。maxResults は rg のフラグではなく
// パーサ側の submatch カウントで打ち切る（rg の --max-count はファイル単位のため）。

import type { TextSearchOptions, TextSearchQuery } from "@gozd/rpc";

/** maxResults 未指定時の上限。VS Code の DEFAULT_MAX_SEARCH_RESULTS 相当。 */
export const DEFAULT_MAX_RESULTS = 20000;

/**
 * 常に検索から外す既定除外。VS Code の files.exclude default と一致させる
 * （`src/vs/workbench/contrib/files/browser/files.contribution.ts` の VCS / OS メタ）。
 *
 * rg は hidden dir（`.git` 含む）を既定でスキップするが、gozd は dotfile も検索したいため
 * `--hidden` を付ける。その副作用で `.git` 等に降りてしまうので、VS Code と同じ既定除外を
 * negate glob として rg に渡して打ち消す。node_modules は VS Code 同様 gitignore 任せで
 * 既定除外に含めない。
 */
const DEFAULT_EXCLUDES = ["**/.git", "**/.svn", "**/.hg", "**/.DS_Store", "**/Thumbs.db"];

/**
 * glob をワークスペース root に錨付けする（VS Code `ripgrepSearchUtils.anchorGlob`）。
 * `**` / `/` 始まりはそのまま、それ以外は先頭に `/` を足して root 相対にする。
 */
function anchorGlob(glob: string): string {
  return glob.startsWith("**") || glob.startsWith("/") ? glob : `/${glob}`;
}

/**
 * パス階層ごとの glob 列に展開する（VS Code `spreadGlobComponents`）。
 * 例: `foo/bar/baz` → `["foo", "foo/bar", "foo/bar/baz"]`。
 * `-g '!*'` で全除外した後、各 include の中間ディレクトリも re-include して rg を
 * 降りさせるために使う（これが無いと root 直下で止まり nested include が 0 件になる）。
 * VS Code は brace 展開も噛ませるが、本実装は単純な `/` 分割に留める。
 */
function spreadGlobComponents(globComponent: string): string[] {
  const components = globComponent.split("/");
  return components.map((_, i) => components.slice(0, i + 1).join("/"));
}

export function getRgArgs(query: TextSearchQuery, options: TextSearchOptions): string[] {
  // --no-require-git: git リポジトリ外でも .gitignore を適用（VS Code と同じ opt-in）
  const args = ["--hidden", "--no-require-git"];
  args.push(query.isCaseSensitive === true ? "--case-sensitive" : "--ignore-case");

  // include: VS Code getRgArgs と同じ二分岐。
  // - `**` 始まり（doubleStar）: `!*` を付けず直接 -g。`**/foo/**` は descent できるため
  //   反転が不要で、`!*` を噛ませると逆に root で止まって 0 件になる（実測済み）
  // - それ以外: `!*` で全除外 → 各パス階層を re-include（spreadGlobComponents）して descent
  const includes = options.includes ?? [];
  const doubleStarIncludes = includes.filter((glob) => glob.startsWith("**"));
  const otherIncludes = includes.filter((glob) => !glob.startsWith("**"));
  if (otherIncludes.length > 0) {
    args.push("-g", "!*");
    for (const include of new Set(otherIncludes)) {
      for (const component of spreadGlobComponents(include)) {
        args.push("-g", anchorGlob(component));
      }
    }
  }
  for (const include of doubleStarIncludes) {
    args.push("-g", include);
  }

  // exclude: 既定除外（VCS / OS メタ）+ 呼び出し側指定の除外を anchorGlob して否定
  for (const exclude of [...DEFAULT_EXCLUDES, ...(options.excludes ?? [])]) {
    args.push("-g", `!${anchorGlob(exclude)}`);
  }

  // .gitignore / .ignore はデフォルト尊重。false のときだけ無効化
  if (options.useIgnoreFiles === false) args.push("--no-ignore");

  args.push("--json");

  const context = options.surroundingContext ?? 0;
  if (context > 0) {
    args.push("--before-context", String(context));
    args.push("--after-context", String(context));
  }

  // 単語境界一致は fixed / regex どちらとも併用可
  if (query.isWordMatch === true) args.push("--word-regexp");

  // 固定文字列は --fixed-strings でパターンをリテラル扱いにする。
  // どちらも --regexp でパターンを値として渡すため、先頭が `-` でも安全
  if (query.isRegExp !== true) args.push("--fixed-strings");
  args.push("--regexp", query.pattern);

  // 検索対象は cwd 全体
  args.push("--", ".");
  return args;
}
