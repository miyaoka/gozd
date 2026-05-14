/**
 * Swift 側 `GhError.Kind` (proto enum `GhErrorKind`) を、ユーザー向け英文に変換する。
 *
 * 観察可能性: トースト本文だけで「何が壊れたか」が分かる必要がある。silent 化 / 一括文言は
 * rate limit 枯渇を発見させない原因になるため、4 種類で文言を区別する。
 */
import { GhErrorKind } from "@gozd/proto";

export function ghErrorMessage(kind: GhErrorKind, action: string): string {
  switch (kind) {
    case GhErrorKind.GH_ERROR_KIND_RATE_LIMIT:
      return `${action}: GitHub API rate limit exhausted`;
    case GhErrorKind.GH_ERROR_KIND_UNAUTHENTICATED:
      return `${action}: gh CLI is not authenticated (run 'gh auth login')`;
    case GhErrorKind.GH_ERROR_KIND_REPO_NOT_FOUND:
      return `${action}: repository not found or no access`;
    case GhErrorKind.GH_ERROR_KIND_NETWORK:
      return `${action}: network error reaching GitHub`;
    case GhErrorKind.GH_ERROR_KIND_OTHER:
    case GhErrorKind.GH_ERROR_KIND_OK:
    case GhErrorKind.UNRECOGNIZED:
      return `${action}: gh CLI failed`;
  }
}
