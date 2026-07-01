/**
 * Diff タブ編集 (右半身 = current 側) の DOM 抽出を仲介する module singleton composable。
 *
 * DiffPreview.vue の編集領域は Shiki トークンの v-for ではなく `v-html` で静的プレーンテキストを
 * 挿入する (CodePreview.vue と同じ理由: contenteditable の DOM 変更を Vue の vnode 管理下に置くと
 * 次回の再レンダリングでユーザーの編集が上書きされる)。v-html は Vue の管理外の DOM なので、
 * 「保存時に DOM を直接読んで最新テキストを抽出する」形でしか値を取り出せない。
 *
 * `defineExpose` 禁止規約 (親から子の内部メソッドを呼ぶ設計を避ける) のため、DiffPreview は
 * mount 時に自分の抽出関数をここに register し、PreviewPane は `extract()` 経由で参照する。
 */
import { ref } from "vue";

interface DiffEditorRegistration {
  extract: () => string;
  /** modified 側の内容を指定テキストで置き換える (Discard 用)。setValue は dirty フラグを
   * 誘発しないよう、呼び出し側 (DiffPreview.vue) で markDirty を再度 false にする責務を持つ。 */
  reset: (content: string) => void;
}

const registration = ref<DiffEditorRegistration>();
const isDirty = ref(false);

export function useDiffEditor() {
  function register(reg: DiffEditorRegistration) {
    registration.value = reg;
    isDirty.value = false;
  }

  function unregister() {
    registration.value = undefined;
    isDirty.value = false;
  }

  function markDirty() {
    isDirty.value = true;
  }

  function markClean() {
    isDirty.value = false;
  }

  /** 現在登録されている編集領域から最新テキストを抽出する。未登録なら undefined。 */
  function extract(): string | undefined {
    return registration.value?.extract();
  }

  /** modified 側を保存済み内容に戻す (Discard)。未登録なら no-op。 */
  function reset(content: string): void {
    registration.value?.reset(content);
  }

  return { register, unregister, markDirty, markClean, extract, reset, isDirty };
}
