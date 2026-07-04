// GitHub 連携。Swift 版 `GitHubOps.swift` の対応物（現段階は repo identity のみ）。

import { tryCatch } from "@gozd/shared";
import { GitCommandError, runGit } from "./gitRunner";

export type RepoIdentity =
  | { kind: "ok"; owner: string; repo: string }
  | { kind: "unsetRemote" }
  | { kind: "parserRejected" };

/**
 * origin remote から GitHub の (owner, repo) を返す。
 *
 * - `unsetRemote`: `remote.origin` が未設定（新規 repo / clone なし）
 * - `parserRejected`: 非 github.com host / 想定外 URL 形式。raw URL は credential
 *   漏出防止のため呼び出し側に渡さない
 */
export async function repoOwnerName(dir: string): Promise<RepoIdentity> {
  const result = await tryCatch(runGit(["config", "--get", "remote.origin.url"], dir));
  if (!result.ok) {
    if (result.error instanceof GitCommandError) return { kind: "unsetRemote" };
    throw result.error;
  }
  const parsed = parseGitHubOwnerRepo(result.value.trim());
  if (parsed === undefined) return { kind: "parserRejected" };
  return { kind: "ok", ...parsed };
}

/**
 * remote URL から (owner, repo) を抽出する。host は `github.com` のみ受理し、
 * それ以外は undefined。`.git` 拡張子は剥がす。
 * `https://host/owner/repo` / `ssh://user@host/owner/repo` / scp 形式 `git@host:owner/repo` に対応
 */
export function parseGitHubOwnerRepo(
  url: string,
): { owner: string; repo: string } | undefined {
  let host: string;
  let path: string;

  const schemeIndex = url.indexOf("://");
  if (schemeIndex >= 0) {
    const afterScheme = url.slice(schemeIndex + 3);
    const slash = afterScheme.indexOf("/");
    if (slash < 0) return undefined;
    let authority = afterScheme.slice(0, slash);
    const at = authority.lastIndexOf("@");
    if (at >= 0) authority = authority.slice(at + 1);
    // port 番号があれば剥がす (host:port)
    const colon = authority.indexOf(":");
    if (colon >= 0) authority = authority.slice(0, colon);
    host = authority;
    path = afterScheme.slice(slash + 1);
  } else {
    const colon = url.indexOf(":");
    if (colon < 0) return undefined;
    // scp 形式: git@host:owner/repo
    let authority = url.slice(0, colon);
    const at = authority.lastIndexOf("@");
    if (at >= 0) authority = authority.slice(at + 1);
    host = authority;
    path = url.slice(colon + 1);
  }

  if (host !== "github.com") return undefined;
  if (path.endsWith(".git")) path = path.slice(0, -4);
  const parts = path.split("/");
  if (parts.length !== 2) return undefined;
  const [owner, repo] = parts;
  if (owner === "" || repo === "") return undefined;
  return { owner, repo };
}
