/**
 * repo list 名の編集 dialog の open state を保持する module singleton。
 *
 * List オブジェクトではなく `listId` だけを保持し、dialog 側は `useRepoStore` から都度
 * 引き直す（open 中に他経路で rename / 削除が起きても表示が追従し、消えたら自動 close）。
 * `useTaskEditing` と同じ流儀。
 */
import { ref } from "vue";

type ListEditContext = {
  listId: string;
};

const context = ref<ListEditContext | undefined>(undefined);

export function useListEditing() {
  function open(listId: string) {
    context.value = { listId };
  }
  function close() {
    context.value = undefined;
  }
  return { context, open, close };
}
