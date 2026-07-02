/**
 * blame / file history popover のヘッダ補助表示に使う rev → ラベル変換。
 *
 * rev の導出 (`currentRev` / `originalRev` / `historyRev`) を所有する `usePreviewRevs` と、
 * ヘッダのコミット日 (FileCommitDate) の両方が同じマッピングを使うため、SSOT として
 * preview feature 内の純関数に切り出す。
 */
export function revModeLabel(rev: string): string {
  if (rev === "") return "Working Tree";
  if (rev === "HEAD") return "HEAD";
  return rev;
}
