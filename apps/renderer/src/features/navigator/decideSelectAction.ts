/**
 * Navigator (Filer / Changes) で file を select する経路の action 決定。
 *
 * 3 状態:
 * - 別 file / preview 閉 / selection 未選択 のいずれか → `select` (通常の selectRelPath)
 * - 同 file かつ preview 開 かつ summary 表示中 → `exit-summary` (summary を抜けて単一 file view へ)
 * - 同 file かつ preview 開 かつ summary 非表示 → `toggle-close` (preview を閉じる)
 *
 * summary 表示中の同 file 再選択を `toggle-close` に倒さないのは、ユーザーの意図が
 * 「summary を抜けてこの file を見たい」である方が自然なため。`onCloseSummary`
 * (明示 close button) と同じく `summaryStore.disable()` を経由する。
 */
export type SelectAction = { kind: "toggle-close" } | { kind: "exit-summary" } | { kind: "select" };

export interface SelectActionInput {
  relPath: string;
  selectedRelPath: string | undefined;
  previewVisible: boolean;
  summaryEnabled: boolean;
}

export function decideSelectAction({
  relPath,
  selectedRelPath,
  previewVisible,
  summaryEnabled,
}: SelectActionInput): SelectAction {
  if (relPath !== selectedRelPath || !previewVisible) {
    return { kind: "select" };
  }
  if (summaryEnabled) return { kind: "exit-summary" };
  return { kind: "toggle-close" };
}
