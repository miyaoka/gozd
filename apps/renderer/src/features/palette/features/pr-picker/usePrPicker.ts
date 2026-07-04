/**
 * PR picker の制御を外部に公開する module singleton composable。
 * PrPickerDialog.vue がリアクティブに状態を読み取り、
 * 外部のコマンドハンドラーは show() を呼ぶだけで dialog が開く。
 */

import type { GitPullRequest } from "@gozd/rpc";
import { ref } from "vue";

const prItems = ref<GitPullRequest[]>([]);
const viewer = ref("");
const showSignal = ref(0);
let acceptCallback: ((pr: GitPullRequest) => void) | undefined;

export function usePrPicker() {
  function show(
    items: GitPullRequest[],
    viewerLogin: string,
    onAccept: (pr: GitPullRequest) => void,
  ) {
    prItems.value = items;
    viewer.value = viewerLogin;
    acceptCallback = onAccept;
    showSignal.value++;
  }

  function accept(pr: GitPullRequest) {
    acceptCallback?.(pr);
  }

  return { prItems, viewer, showSignal, show, accept };
}
