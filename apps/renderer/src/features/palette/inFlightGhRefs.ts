/**
 * accept 実行中 (worktree / task の作成・切り替え) の対象キー集合を保持する module singleton。
 * 判定の所在はコマンド層 (registerPrCommand / registerIssueCommand) の add / remove で、
 * 実行中の対象をどう扱うかもそこが決める。dialog がこの集合から導出するのは行の
 * スピナー表示だけで、選択とハイライトは通常どおり動く。
 *
 * dialog ローカルの状態にしないのは、通常選択 (close 後の fire-and-forget 実行) や picker の
 * 開き直しで dialog 状態が破棄され、実行中かどうかを見失うため。picker セッションを跨いで
 * 判定が生き残ることで、開き直した一覧でも当該行のスピナーが維持される。
 */

import type { GhRef } from "@gozd/rpc";
import { ref } from "vue";
import { ghRefKey } from "./taskIndexByGhRef";

/** 排他キー。GitHub の番号空間は repo 単位なので rootDir を含め、repo を跨いだ
 * 同番号の誤ブロックを避ける。 */
export function inFlightKey(rootDir: string, ghRef: GhRef): string {
  return `${rootDir}:${ghRefKey(ghRef)}`;
}

const keys = ref(new Set<string>());

const store = {
  has(key: string): boolean {
    return keys.value.has(key);
  },
  add(key: string): void {
    keys.value.add(key);
  },
  remove(key: string): void {
    keys.value.delete(key);
  },
};

export function useInFlightGhRefs() {
  return store;
}
