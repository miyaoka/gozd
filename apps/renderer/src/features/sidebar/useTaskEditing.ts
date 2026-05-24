/**
 * task title 編集 dialog の open state を保持する module singleton。
 *
 * TaskRow のダブルクリックでも TaskMenu の Rename でも、open(task, rootDir) を呼ぶと
 * SidebarPane が描画する TaskEditDialog が表示される。dialog 側は context を購読して
 * input / preview を組み立てる。複数 task を同時編集する設計は持たない。
 */
import type { Task } from "@gozd/proto";
import { ref } from "vue";

type TaskEditContext = {
  task: Task;
  rootDir: string;
};

const context = ref<TaskEditContext | undefined>(undefined);

export function useTaskEditing() {
  function open(task: Task, rootDir: string) {
    context.value = { task, rootDir };
  }
  function close() {
    context.value = undefined;
  }
  return { context, open, close };
}
