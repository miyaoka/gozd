/**
 * Preview ペインのテキスト編集（CodePreview が描画される Current タブ限定）の
 * edit mode / dirty state / 保存を管理する pinia store。
 *
 * 対象は worktree 相対パスの実ファイルのみ（`fsWriteFile` が dir + relPath でしか書けないため）。
 * 保存は明示的（Cmd+S / 保存ボタン）で、debounce による自動保存は行わない。
 *
 * ## 「モードを抜ける」と「データ操作」を分離する契約
 *
 * `save` / `discard` はどちらも draftContent に対する**データ操作**であり、`editMode` を
 * 変化させない（保存/破棄しても編集画面は開いたまま。VSCode の Cmd+S がエディタを閉じないのと同じ）。
 * `editMode` を false にする「表示を read-only に戻す」操作は `exitEditMode` に一本化する。
 * こうすることで、真逆の破壊的アクションである save/discard に「モードを抜ける」という
 * 3 つ目の意味を持たせず、ボタンの責務を単純に保つ。
 *
 * `exitEditMode` は draftContent を破棄しない (unmount するだけ)。再度 `startEdit` で同じ
 * target に対して呼ばれた場合、呼び出し側 (`usePreviewEdit`) が最新の currentContent を渡すため、
 * 前回の未保存 draft は結果的に失われる。「編集内容を保持したまま閉じる」までは要求されていない
 * ため、シンプルさを優先する (必要になったら target 一致時に draftContent を保つ判定を足す)。
 */
import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { rpcFsWriteFile } from "../filer";

interface EditTarget {
  dir: string;
  relPath: string;
}

export const usePreviewEditStore = defineStore("preview-edit", () => {
  const notification = useNotificationStore();

  const editMode = ref(false);
  const draftContent = ref<string>();
  const saving = ref(false);
  const target = ref<EditTarget>();

  /** 直近の保存済み内容。dirty 判定の基準であり discard の復元先でもある */
  const savedContent = ref<string>();

  const isDirty = computed(() => editMode.value && draftContent.value !== savedContent.value);

  function startEdit(dir: string, relPath: string, content: string) {
    target.value = { dir, relPath };
    draftContent.value = content;
    savedContent.value = content;
    editMode.value = true;
  }

  /** 表示を read-only に戻すだけ。draft の破棄/保存の意味は持たない */
  function exitEditMode() {
    editMode.value = false;
    draftContent.value = undefined;
    savedContent.value = undefined;
    target.value = undefined;
  }

  /** 未保存の変更を保存済み内容に戻す。editMode は維持する */
  function discard() {
    draftContent.value = savedContent.value;
  }

  function updateDraft(content: string) {
    draftContent.value = content;
  }

  /** 保存成功時、書き込んだ内容を返す（呼び出し側が楽観的に表示コンテンツを更新するため） */
  async function save(): Promise<string | undefined> {
    if (!editMode.value) return undefined;
    // Cmd+S はボタンの :disabled="saving" を経由しないため、ここで再入を弾く。
    if (saving.value) return undefined;
    const t = target.value;
    const content = draftContent.value;
    if (t === undefined || content === undefined) return undefined;

    saving.value = true;
    const result = await tryCatch(rpcFsWriteFile({ dir: t.dir, path: t.relPath, content }));
    saving.value = false;

    if (!result.ok) {
      notification.error(`Failed to save ${t.relPath}`, result.error);
      return undefined;
    }

    savedContent.value = content;
    return content;
  }

  return {
    editMode,
    draftContent,
    savedContent,
    isDirty,
    saving,
    startEdit,
    exitEditMode,
    discard,
    updateDraft,
    save,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePreviewEditStore, import.meta.hot));
}
