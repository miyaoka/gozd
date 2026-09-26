/**
 * accept 実行中 (worktree の作成・切り替え) の対象キー集合を保持する module singleton。
 * 集合への add / remove はコマンド層 (registerPrCommand / registerIssueCommand) が行い、
 * dialog は参照するだけ。行のスピナー表示は両 picker ともこの集合から導出する。
 *
 * dialog ローカルの状態にしないのは、通常選択 (close 後の fire-and-forget 実行) や picker の
 * 開き直しで dialog 状態が破棄され、実行中かどうかを見失うため。picker セッションを跨いで
 * 判定が生き残ることで、開き直した一覧でも当該行のスピナーが維持される。
 */

import { ref } from "vue";

/** 排他キー。GitHub の番号空間は repo 単位なので rootDir を含め、repo を跨いだ
 * 同番号の誤ブロックを避ける。PR と issue は同じ番号空間を共有するが、picker ごとに
 * 排他するため kind も含める。 */
export function inFlightKey(rootDir: string, kind: "pr" | "issue", number: number): string {
  return `${rootDir}:${kind}#${number}`;
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

export function useInFlightItems() {
  return store;
}
