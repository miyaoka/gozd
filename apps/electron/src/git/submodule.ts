// submodule の閲覧 URL 解決。filer の submodule 行から「その submodule の repo ページ」へ
// 飛ぶために使う。
//
// path → url の対応は `.gitmodules` にしか無い（index の gitlink は commit hash しか持たない）。
// 一方 filer の submodule 判定は index の gitlink が SSOT で、`.gitmodules` は参照しない。
// 2 つの出所を分けているのは役割が違うため: index は「submodule か」と「どの commit か」、
// `.gitmodules` は「どこから取ってくるか」を持つ。記述の無い gitlink は URL が解決できないだけで
// submodule として表示されること自体は変わらない。

import { tryCatch } from "@gozd/shared";
import { parseGitHubOwnerRepo, repoOwnerName } from "./github";
import { runGit } from "./gitRunner";
import { validateRelPath, validateRev } from "./gitValidate";

interface OwnerRepo {
  owner: string;
  repo: string;
}

/** `.gitmodules` の 1 submodule 分の設定 */
interface GitmodulesEntry {
  path?: string;
  url?: string;
}

/**
 * submodule が指す commit の GitHub 閲覧 URL を返す。解決できなければ undefined。
 *
 * `rev` を渡すとその revision の `.gitmodules` blob を読む。filer の snapshot mode では hash が
 * 過去 commit 由来なので、url を working tree の `.gitmodules` から引くと、同じ path の submodule
 * が commit 間で別 repo に差し替わっていた場合に「実在する別 repo の URL に過去の hash」という
 * 誤リンクになる。
 *
 * undefined を返すのは以下すべて。呼び出し側は「リンク先が無い」ことをユーザーに伝える責務を持つ
 * （無音で不発にしない）:
 * - `.gitmodules` が読めない（不在 / 指定 revision に無い / git 管理外）
 * - その path に対応する記述が無い
 * - url が非 github.com host
 * - 相対 url（gitmodules(5) の `./` / `../` 形式）で、superproject の origin が未設定 or
 *   非 github.com host、あるいは解決結果が `owner/repo` の 2 成分にならない
 */
export async function submoduleBrowseUrl(
  dir: string,
  relPath: string,
  hash: string,
  rev?: string,
): Promise<string | undefined> {
  validateRelPath(relPath);
  validateRev(hash);
  if (relPath === "" || hash === "") return undefined;
  const url = await readSubmoduleUrl(dir, relPath, rev);
  if (url === undefined) return undefined;
  const target = await resolveOwnerRepo(dir, url);
  if (target === undefined) return undefined;
  return `https://github.com/${target.owner}/${target.repo}/tree/${hash}`;
}

/** `.gitmodules` から path に対応する url を読む。読めなければ undefined */
async function readSubmoduleUrl(
  dir: string,
  relPath: string,
  rev: string | undefined,
): Promise<string | undefined> {
  if (rev !== undefined) validateRev(rev);
  const source = rev === undefined ? ["--file", ".gitmodules"] : ["--blob", `${rev}:.gitmodules`];
  // `.gitmodules` 不在 / 指定 revision に無い / git 管理外は exit code != 0。URL 無しとして扱う
  const result = await tryCatch(
    runGit(["config", "-z", ...source, "--get-regexp", "^submodule\\."], dir),
  );
  if (!result.ok) return undefined;
  for (const entry of parseGitmodulesConfig(result.value).values()) {
    if (entry.path === relPath) return entry.url;
  }
  return undefined;
}

/** url を GitHub の owner / repo に解決する。相対 url は superproject の origin を基準にする */
async function resolveOwnerRepo(dir: string, url: string): Promise<OwnerRepo | undefined> {
  if (!isRelativeUrl(url)) return parseGitHubOwnerRepo(url);
  const origin = await repoOwnerName(dir);
  if (origin.kind !== "ok") return undefined;
  return resolveRelativeOwnerRepo(origin, url);
}

/** gitmodules(5) が定める相対 url か（superproject の origin からの相対位置を表す） */
function isRelativeUrl(url: string): boolean {
  return url.startsWith("./") || url.startsWith("../");
}

/**
 * 相対 url を superproject の owner / repo に対して解決する。
 *
 * git 本体の `resolve_relative_url` と同じく `../` 1 つで末尾 1 成分を落とし、`./` は現在位置と
 * して読み飛ばす。`owner/repo` の 2 成分に収まらない結果（`./lib` のような下位への降下や、
 * `../` の行き過ぎ）は GitHub 上に対応するページが無いため undefined を返す。
 */
export function resolveRelativeOwnerRepo(
  origin: OwnerRepo,
  relativeUrl: string,
): OwnerRepo | undefined {
  const parts = [origin.owner, origin.repo];
  for (const segment of relativeUrl.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  if (parts.length !== 2) return undefined;
  const [owner = "", repo = ""] = parts;
  const name = repo.endsWith(".git") ? repo.slice(0, -".git".length) : repo;
  if (owner === "" || name === "") return undefined;
  return { owner, repo: name };
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
