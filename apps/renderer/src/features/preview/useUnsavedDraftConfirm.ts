/**
 * 未保存 draft を破棄する操作 (preview close / ファイル切替 / undocked window close) の
 * 確認 state。
 *
 * useClosePaneConfirm と同じ「実行するクロージャを預かる」構造。破棄対象がファイル編集
 * なので選択肢は Save / Don't Save / Cancel の 3 択 (VS Code の close confirmation と同じ
 * 意味論)。save がクリーン化に失敗した場合は proceed を実行しない (veto: 保存できていない
 * draft を道連れに破棄しない)。
 *
 * draft の SSOT は要求元ごとに異なる (本体 = usePreviewEditStore / undocked window =
 * window ローカル ref) ため、ここは save / discard / proceed のクロージャだけを預かり
 * 編集状態の知識を持ち込まない。
 *
 * instance は「ダイアログを出すウィンドウ」の単位で分ける: main window は shared singleton
 * (`useUnsavedDraftConfirm`)、undock された child window は per-window に
 * `createUnsavedDraftConfirm()` して自分の document 内にダイアログを描く。singleton を
 * 共有するとダイアログの表示先が MainLayout (main window) に固定され、child 側の close
 * 確認が別ウィンドウに出てしまう。
 */
import { ref } from "vue";

export interface UnsavedDraftRequest {
  /** ダイアログに表示するファイル名 */
  fileName: string;
  /** 保存を試みる。クリーン化に成功したら true (失敗時のエラー通知は実装側の責務) */
  save: () => Promise<boolean>;
  /** 未保存の変更を破棄する */
  discard: () => void;
  /** Save 成功 / Don't Save 後に実行する本来の破棄操作 */
  proceed: () => void;
}

export type UnsavedDraftConfirm = ReturnType<typeof createUnsavedDraftConfirm>;

export function createUnsavedDraftConfirm() {
  const pending = ref<UnsavedDraftRequest>();
  const saving = ref(false);
  /**
   * 確認を要求する。確認中の再投入は無視する (先勝ち)。上書きを許すとダイアログ表示中に
   * 別の破棄操作が走ったとき proceed が別対象に差し替わるため、構造的に防ぐ
   * (useClosePaneConfirm と同じ理由)。
   */
  function request(req: UnsavedDraftRequest) {
    if (pending.value !== undefined) return;
    pending.value = req;
  }

  /** 確認を取り下げる (Cancel / backdrop / ESC)。消化済みなら no-op */
  function cancel() {
    if (saving.value) return;
    pending.value = undefined;
  }

  /** Save: 保存を試み、クリーン化に成功したときだけ proceed する (失敗 = veto) */
  async function chooseSave() {
    const req = pending.value;
    if (req === undefined || saving.value) return;
    saving.value = true;
    let ok = false;
    // save の契約は「reject せず boolean を返す」だが、saving はこの module が所有する
    // 状態なので契約違反 (reject) でも finally でリセットを構造保証する。リークすると
    // 全ボタン disabled + ESC 遮断のダイアログが永久デッドロックになるため
    try {
      ok = await req.save();
    } finally {
      saving.value = false;
      pending.value = undefined;
    }
    if (ok) req.proceed();
  }

  /** Don't Save: draft を破棄して proceed する */
  function chooseDiscard() {
    const req = pending.value;
    if (req === undefined || saving.value) return;
    pending.value = undefined;
    req.discard();
    req.proceed();
  }

  return { pending, saving, request, cancel, chooseSave, chooseDiscard };
}

/** main window 用の shared instance (ダイアログは MainLayout が描く)。 */
const shared = createUnsavedDraftConfirm();

export function useUnsavedDraftConfirm() {
  return shared;
}
