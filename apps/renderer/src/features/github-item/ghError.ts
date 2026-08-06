/**
 * main 側 `classifyGhStderr`（`GhErrorKind`）の分類を、ユーザー向け英文に変換する。
 *
 * 観察可能性: トースト本文だけで「何が壊れたか」が分かる必要がある。silent 化 / 一括文言は
 * rate limit 枯渇を発見させない原因になるため、4 種類で文言を区別する。
 */
import type { GhErrorKind } from "@gozd/rpc";

// "ok" は ok=false 応答で来ない契約だが、Record の全域性で網羅を強制するため文言を持たせる
const GH_ERROR_TEXT: Record<GhErrorKind, string> = {
  ok: "gh CLI failed",
  rateLimit: "GitHub API rate limit exhausted",
  unauthenticated: "gh CLI is not authenticated (run 'gh auth login')",
  repoNotFound: "repository not found or no access",
  network: "network error reaching GitHub",
  other: "gh CLI failed",
};

export function ghErrorMessage(kind: GhErrorKind, action: string): string {
  return `${action}: ${GH_ERROR_TEXT[kind]}`;
}

/**
 * 観察ログに載せる gh 失敗の要約。トースト向けの文言と別なのは、こちらが原因の特定に使う
 * 記録で stderr を要するため。分類だけでは `other` に落ちた失敗を区別できない。
 */
export function ghErrorLogDetail(kind: GhErrorKind, detail: string): string {
  return detail === "" ? kind : `${kind}: ${detail}`;
}
