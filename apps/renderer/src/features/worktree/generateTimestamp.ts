// worktree 用タイムスタンプ (YYYYMMDD_HHMMSS) の SSOT は `@gozd/shared`。
// electron main (revive の branch 衝突 fallback) と実装を共有するため shared に置き、ここは再 export。
export { generateTimestamp } from "@gozd/shared";
