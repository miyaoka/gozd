// submodule の閲覧 URL 解決。filer の submodule 行から「その submodule の repo ページ」へ
// 飛ぶために使う。
//
// path → url の対応は `.gitmodules` にしか無い（index の gitlink は commit hash しか持たない）。
// 一方 filer の submodule 判定は index の gitlink が SSOT で、`.gitmodules` は参照しない。
// 2 つの出所を分けているのは役割が違うため: index は「submodule か」と「どの commit か」、
// `.gitmodules` は「どこから取ってくるか」を持つ。記述の無い gitlink は URL が解決できないだけで
// submodule として表示されること自体は変わらない。

import { tryCatch } from "@gozd/shared";
import { parseGitHubOwnerRepo } from "./github";
import { runGit } from "./gitRunner";
import { validateRelPath, validateRev } from "./gitValidate";

/** `.gitmodules` の 1 submodule 分の設定 */
interface GitmodulesEntry {
  path?: string;
  url?: string;
}

/**
 * submodule が指す commit の GitHub 閲覧 URL を返す。解決できなければ undefined。
 *
 * undefined になるのは `.gitmodules` に記述が無い / url が非 github.com host の場合。
 * 呼び出し側は「リンク先が無い」ことをユーザーに伝える責務を持つ（無音で不発にしない）。
 */
export async function submoduleBrowseUrl(
  dir: string,
  relPath: string,
  hash: string,
): Promise<string | undefined> {
  validateRelPath(relPath);
  validateRev(hash);
  if (relPath === "" || hash === "") return undefined;
  // `.gitmodules` 不在 / git 管理外は exit code != 0。URL 無しとして扱う
  const result = await tryCatch(
    runGit(["config", "-z", "--file", ".gitmodules", "--get-regexp", "^submodule\\."], dir),
  );
  if (!result.ok) return undefined;
  const url = findSubmoduleUrl(parseGitmodulesConfig(result.value), relPath);
  if (url === undefined) return undefined;
  const parsed = parseGitHubOwnerRepo(url);
  if (parsed === undefined) return undefined;
  return `https://github.com/${parsed.owner}/${parsed.repo}/tree/${hash}`;
}

/**
 * `git config -z --get-regexp` の出力を submodule 名ごとの設定に畳む。
 *
 * `-z` の 1 レコードは `<key> LF <value>` で NUL 区切り。値に改行を含み得るため
 * 最初の LF だけを区切りとして扱う。key は `submodule.<name>.<property>` で、**name 自身が
 * `.` を含み得る**（`.gitmodules` の name は既定で path と同じ文字列なので、パスにドットが
 * あればそのまま入る）ため、property は末尾の `.` から切り出す。
 */
export function parseGitmodulesConfig(text: string): Map<string, GitmodulesEntry> {
  const entries = new Map<string, GitmodulesEntry>();
  for (const record of text.split("\0")) {
    if (record === "") continue;
    const lineFeed = record.indexOf("\n");
    // 値を持たない key（`.gitmodules` に `submodule.x.path` だけ書いて値が空等）は
    // path / url のどちらにもならないので読み飛ばす
    if (lineFeed < 0) continue;
    const key = record.slice(0, lineFeed);
    const value = record.slice(lineFeed + 1);
    if (!key.startsWith("submodule.")) continue;
    const rest = key.slice("submodule.".length);
    const lastDot = rest.lastIndexOf(".");
    if (lastDot < 0) continue;
    const name = rest.slice(0, lastDot);
    const property = rest.slice(lastDot + 1);
    if (property !== "path" && property !== "url") continue;
    const entry = entries.get(name) ?? {};
    entries.set(name, { ...entry, [property]: value });
  }
  return entries;
}

/** path が一致する submodule の url を返す。name ではなく path で引くのは、filer が持つのが
 * ツリー上の相対パスであり、name は `.gitmodules` 側の任意ラベルでしかないため */
function findSubmoduleUrl(
  entries: Map<string, GitmodulesEntry>,
  relPath: string,
): string | undefined {
  for (const entry of entries.values()) {
    if (entry.path === relPath) return entry.url;
  }
  return undefined;
}
