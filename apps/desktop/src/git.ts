/** remote URL から owner/repo を抽出するパターン（HTTPS / SSH / ssh:// 対応、ローカルパスは除外） */
const REMOTE_OWNER_REPO_RE =
  /^(?:(?:https?|ssh):\/\/[^/]+\/|[^@]+@[^:]+:)([^/:]+\/[^/]+?)(?:\.git)?$/;

/** remote URL から owner/repo 形式の名前を抽出する。マッチしなければ undefined */
export function parseOwnerRepo(url: string): string | undefined {
  const match = url.match(REMOTE_OWNER_REPO_RE);
  return match?.[1];
}
