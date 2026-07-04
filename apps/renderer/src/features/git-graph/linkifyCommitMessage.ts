interface TextSegment {
  type: "text";
  value: string;
}

interface IssueSegment {
  type: "issue";
  value: string;
  href: string;
}

export type CommitMessageSegment = TextSegment | IssueSegment;

/** main 側 `parseGitHubOwnerRepo`（`src/git/github.ts`）で parse 済みの `(owner, repo)` から
 * GitHub の repo base URL を組み立てる。remote 未設定 / 非 github.com host (parser が失敗で
 * 返す経路) は両方が空文字で届くため undefined に倒し、renderer は `#N` を plain text に保つ。
 *
 * remote URL の文字列 parse / SSH 形式の正規化 / `.git` suffix 剥がし / host policy 判定は
 * main 側 1 箇所 (`parseGitHubOwnerRepo`) で完結している。renderer は構造化済み
 * identifier を受け取って文字列を組み立てるだけ。
 *
 * GitHub は `/issues/<n>` も `/pull/<n>` も互いにリダイレクトするため、base から
 * `/issues/<n>` を組み立てれば issue / PR の判別なしに飛べる。 */
export function buildRepoBaseUrl(
  identity: { owner: string; repo: string } | undefined,
): string | undefined {
  if (identity === undefined) return undefined;
  if (identity.owner === "" || identity.repo === "") return undefined;
  return `https://github.com/${identity.owner}/${identity.repo}`;
}

/** `#数字` パターン。前が単語境界 (英数字 / `&` 直後を除外) で数字が連続するもの。
 * `&#123;` のような HTML entity 風や `foo#456` のような fragment は対象外。 */
const ISSUE_REF_RE = /(?<![\w&])#(\d+)(?!\w)/g;

/** コミットメッセージを linkify 可能なセグメント列に分割する。
 * baseUrl が undefined のときは全文を text 1 セグメントで返す。
 * baseUrl は `buildRepoBaseUrl` 経由で構築された `https://github.com/<owner>/<repo>` のため、
 * `${baseUrl}/issues/${numberStr}` の補間は安全 (注入経路なし)。 */
export function linkifyCommitMessage(
  message: string,
  baseUrl: string | undefined,
): CommitMessageSegment[] {
  if (baseUrl === undefined || message === "") {
    return [{ type: "text", value: message }];
  }

  const segments: CommitMessageSegment[] = [];
  let lastIndex = 0;

  for (const match of message.matchAll(ISSUE_REF_RE)) {
    const start = match.index;
    if (start > lastIndex) {
      segments.push({ type: "text", value: message.slice(lastIndex, start) });
    }
    const numberStr = match[1];
    segments.push({
      type: "issue",
      value: match[0],
      href: `${baseUrl}/issues/${numberStr}`,
    });
    lastIndex = start + match[0].length;
  }

  if (lastIndex < message.length) {
    segments.push({ type: "text", value: message.slice(lastIndex) });
  }

  return segments;
}
