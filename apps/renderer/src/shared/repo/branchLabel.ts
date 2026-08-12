const DETACHED_BRANCH_LABEL = "(detached)";

/**
 * ワイヤ契約では detached HEAD を空文字で表現するため `??` では吸えない。
 * 「空文字 or undefined なら detached」を明示比較で判定する。
 */
export function branchLabel(branch: string | undefined): string {
  if (branch === undefined || branch === "") return DETACHED_BRANCH_LABEL;
  return branch;
}
