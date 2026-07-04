/**
 * Issue picker の制御を外部に公開する module singleton composable。
 * IssuePickerDialog.vue がリアクティブに状態を読み取り、
 * 外部のコマンドハンドラーは show() を呼ぶだけで dialog が開く。
 */

import type { GitIssue } from "@gozd/rpc";
import { ref } from "vue";

const issueItems = ref<GitIssue[]>([]);
const viewer = ref("");
const showSignal = ref(0);
let acceptCallback: ((issue: GitIssue) => void) | undefined;

export function useIssuePicker() {
  function show(items: GitIssue[], viewerLogin: string, onAccept: (issue: GitIssue) => void) {
    issueItems.value = items;
    viewer.value = viewerLogin;
    acceptCallback = onAccept;
    showSignal.value++;
  }

  function accept(issue: GitIssue) {
    acceptCallback?.(issue);
  }

  return { issueItems, viewer, showSignal, show, accept };
}
