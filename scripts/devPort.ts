// dev runner の Vite port 導出の純粋部。worktree の realpath から決定論的に base port を
// 導出する。probe（isPortFree）や spawn の副作用は dev.ts 側に置き、このモジュールは
// 単体テストで決定論性・帯内収束を固定できる形に分離する。

import { createHash } from "node:crypto";

// 16800..16999: 旧固定値 16873 を含む帯。macOS の ephemeral port（49152-65535）の外なので
// OS の自動割当とは衝突しない
export const PORT_BASE = 16800;
export const PORT_RANGE = 200;
export const PORT_SWEEP = 16;

export function derivePortBase(seedInput: string): number {
  const seed = Number.parseInt(
    createHash("sha256").update(seedInput).digest("hex").slice(0, 8),
    16,
  );
  // base を帯末尾から PORT_SWEEP 分引いた範囲に丸め、probe の最大到達点（base + PORT_SWEEP - 1）
  // が宣言帯 16800..16999 を超えないようにする（帯の宣言 = 実挙動を保つ）
  return PORT_BASE + (seed % (PORT_RANGE - PORT_SWEEP));
}
