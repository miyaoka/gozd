/**
 * Diff タブ編集 (右半身 = current 側) の Monaco modified model を仲介する module singleton
 * composable。編集内容の SSOT は usePreviewEditStore の draftContent (Monaco の
 * onDidChangeModelContent が `update:modelValue` emit 経由で反映する、CodeEditor.vue と同じ契約)。
 * ここが持つのは Discard 時に Monaco 側へ内容を書き戻す `reset` だけ。
 *
 * `defineExpose` 禁止規約 (親から子の内部メソッドを呼ぶ設計を避ける) のため、DiffPreview は
 * mount 時に自分の reset 関数をここに register し、PreviewPane は `reset()` 経由で参照する。
 */
import { ref } from "vue";

interface DiffEditorRegistration {
  /** modified 側の内容を指定テキストで置き換える (Discard 用)。 */
  reset: (content: string) => void;
}

const registration = ref<DiffEditorRegistration>();

export function useDiffEditor() {
  function register(reg: DiffEditorRegistration) {
    registration.value = reg;
  }

  function unregister() {
    registration.value = undefined;
  }

  /** modified 側を保存済み内容に戻す (Discard)。未登録なら no-op。 */
  function reset(content: string): void {
    registration.value?.reset(content);
  }

  return { register, unregister, reset };
}
