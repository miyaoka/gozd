/**
 * task title 編集 dialog の open state を保持する module singleton。
 *
 * Task オブジェクト自体ではなく `taskId` だけを保持する。dialog 側は `useRepoStore` から
 * 都度引き直すことで、open 中に OSC タイトル更新 / fetchRepo / attachSession 等で Task
 * オブジェクト identity が差し替わっても Sources 表示が live で追従する。
 */
import { ref } from "vue";

type TaskEditContext = {
  taskId: string;
  rootDir: string;
};

const context = ref<TaskEditContext | undefined>(undefined);

export function useTaskEditing() {
  function open(taskId: string, rootDir: string) {
    context.value = { taskId, rootDir };
  }
  function close() {
    context.value = undefined;
  }
  return { context, open, close };
}
