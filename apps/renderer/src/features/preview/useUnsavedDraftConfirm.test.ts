/**
 * useUnsavedDraftConfirm の Save 経路のテスト。「保存できていない draft を道連れに破棄しない」
 * (veto) がデータ安全性の中核なので、成功 / 失敗 / 契約違反 (reject) の 3 経路を pin する。
 * Cancel / Don't Save / 先勝ち再入は usePreviewStore.test.ts が実経路ごと踏んでいる。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { type UnsavedDraftRequest, useUnsavedDraftConfirm } from "./useUnsavedDraftConfirm";

function makeRequest(save: () => Promise<boolean>) {
  const calls = { discard: 0, proceed: 0 };
  const request: UnsavedDraftRequest = {
    fileName: "a.ts",
    save,
    discard: () => {
      calls.discard++;
    },
    proceed: () => {
      calls.proceed++;
    },
  };
  return { request, calls };
}

beforeEach(() => {
  useUnsavedDraftConfirm().cancel();
});

describe("useUnsavedDraftConfirm.chooseSave", () => {
  test("save 成功 (クリーン化) で proceed を実行する", async () => {
    const confirm = useUnsavedDraftConfirm();
    const { request, calls } = makeRequest(async () => true);
    confirm.request(request);

    await confirm.chooseSave();

    expect(calls.proceed).toBe(1);
    expect(calls.discard).toBe(0);
    expect(confirm.pending.value).toBeUndefined();
    expect(confirm.saving.value).toBe(false);
  });

  test("save 失敗 (クリーン化できず) は veto: proceed を実行せず確認だけ畳む", async () => {
    const confirm = useUnsavedDraftConfirm();
    const { request, calls } = makeRequest(async () => false);
    confirm.request(request);

    await confirm.chooseSave();

    expect(calls.proceed).toBe(0);
    expect(confirm.pending.value).toBeUndefined();
    expect(confirm.saving.value).toBe(false);
  });

  test("save が契約違反で reject しても saving / pending をリセットする (デッドロック防止)", async () => {
    const confirm = useUnsavedDraftConfirm();
    const { request, calls } = makeRequest(async () => {
      throw new Error("boom");
    });
    confirm.request(request);

    // 例外自体は伝播する契約 (握りつぶさない)。状態のリセットだけを保証する
    let rejected = false;
    await confirm.chooseSave().catch(() => {
      rejected = true;
    });

    expect(rejected).toBe(true);
    expect(calls.proceed).toBe(0);
    expect(confirm.pending.value).toBeUndefined();
    expect(confirm.saving.value).toBe(false);
  });

  test("saving 中の cancel / chooseDiscard / 再 chooseSave は無視される", async () => {
    const confirm = useUnsavedDraftConfirm();
    let release: ((ok: boolean) => void) | undefined;
    const { request, calls } = makeRequest(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    confirm.request(request);

    const saving = confirm.chooseSave();
    expect(confirm.saving.value).toBe(true);

    confirm.cancel();
    confirm.chooseDiscard();
    void confirm.chooseSave();
    expect(confirm.pending.value).toBeDefined();
    expect(calls.discard).toBe(0);

    release?.(true);
    await saving;
    expect(calls.proceed).toBe(1);
    expect(confirm.saving.value).toBe(false);
  });
});
