/**
 * Preview ペインのテキスト編集（Current タブ限定）の編集セッション / dirty state / 保存を
 * 管理する pinia store。
 *
 * 編集可能ファイルは常に編集状態で表示する（明示的な edit mode トグルは持たない）。
 * 「編集セッション」= target（dir + relPath）と draft / saved の組で、編集可能な content が
 * 表示されるたびに `beginSession` が同期する（`usePreviewEdit` の watch が呼び出し元）。
 *
 * 対象は worktree 相対パスの実ファイルのみ（`fsWriteFile` が dir + relPath でしか書けないため）。
 * 保存は明示的（Cmd+S / 保存ボタン）で、debounce による自動保存は行わない。
 *
 * ## dirty を保護境界にする契約
 *
 * 「未保存の変更があるか (isDirty)」を外部変更に対する保護境界にする: dirty なら外部変更で
 * draft を上書きしない、クリーンなら外部変更に追従して `beginSession` がセッションを張り替える
 * (VS Code のエディタバッファと同じ意味論)。
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

  const draftContent = ref<string>();
  const saving = ref(false);
  const target = ref<EditTarget>();

  /** 直近の保存済み内容。dirty 判定の基準であり discard の復元先でもある */
  const savedContent = ref<string>();

  const isDirty = computed(
    () => draftContent.value !== undefined && draftContent.value !== savedContent.value,
  );

  /** 編集セッションが張られているか。Cmd+S の可否 / context key の SSOT */
  const hasSession = computed(() => draftContent.value !== undefined);

  /**
   * 編集セッションを content に同期する。同一 target かつ保存済み内容が一致するなら
   * 既存の draft（未保存の編集）を保持して no-op。それ以外（別ファイル / 外部変更で
   * content が動いた）は draft を破棄してセッションを張り替える。
   * dirty な draft の保護は呼び出し側（fsChange / 再取得経路の isDirty ガード）が担い、
   * ここまで到達した content は常に「表示すべき最新」として扱う。
   */
  function beginSession(dir: string, relPath: string, content: string) {
    const t = target.value;
    if (
      t?.dir === dir &&
      t.relPath === relPath &&
      savedContent.value === content &&
      draftContent.value !== undefined
    ) {
      return;
    }
    target.value = { dir, relPath };
    draftContent.value = content;
    savedContent.value = content;
  }

  /** セッションを畳む（表示対象の切替 / summary view 進入）。未保存 draft は破棄される */
  function endSession() {
    draftContent.value = undefined;
    savedContent.value = undefined;
    target.value = undefined;
  }

  /** 未保存の変更を保存済み内容に戻す */
  function discard() {
    draftContent.value = savedContent.value;
  }

  function updateDraft(content: string) {
    draftContent.value = content;
  }

  /** 保存成功時、書き込んだ内容を返す（呼び出し側が楽観的に表示コンテンツを更新するため） */
  async function save(): Promise<string | undefined> {
    // クリーンなら書かない (VS Code の Cmd+S と同じ no-op)。Save ボタンは dirty 時のみ
    // 表示されるが、Cmd+S はセッションがあれば発火するため、ここで弾かないと内容不変の
    // 書き込みで mtime だけ動き fsChange の無駄往復が起きる。
    if (!isDirty.value) return undefined;
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
    draftContent,
    savedContent,
    isDirty,
    hasSession,
    saving,
    beginSession,
    endSession,
    discard,
    updateDraft,
    save,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePreviewEditStore, import.meta.hot));
}
