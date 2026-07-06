import { beforeEach, describe, expect, test } from "bun:test";
import { useClosePaneConfirm } from "./useClosePaneConfirm";

describe("useClosePaneConfirm", () => {
  // module singleton なので各テスト前に確認状態を畳んでおく
  beforeEach(() => {
    useClosePaneConfirm().cancel();
  });

  test("request で pendingAction が立つ", () => {
    const { pendingAction, request } = useClosePaneConfirm();
    expect(pendingAction.value).toBeUndefined();
    request(() => {});
    expect(pendingAction.value).toBeDefined();
  });

  test("confirm は action を 1 回だけ実行して確認を畳む", () => {
    const { pendingAction, request, confirm } = useClosePaneConfirm();
    let count = 0;
    request(() => {
      count++;
    });
    confirm();
    expect(count).toBe(1);
    expect(pendingAction.value).toBeUndefined();
    // 連打しても 2 回目は pendingAction が消えているので no-op
    confirm();
    expect(count).toBe(1);
  });

  test("confirm 後の cancel は action を再実行しない（@close 経路の二重実行防止）", () => {
    const { request, confirm, cancel } = useClosePaneConfirm();
    let count = 0;
    request(() => {
      count++;
    });
    // confirm が pendingAction を先に消化するため、後続の dialog @close → cancel は no-op になる
    confirm();
    cancel();
    expect(count).toBe(1);
  });

  test("cancel は action を実行せず確認を畳む", () => {
    const { pendingAction, request, cancel } = useClosePaneConfirm();
    let count = 0;
    request(() => {
      count++;
    });
    cancel();
    expect(count).toBe(0);
    expect(pendingAction.value).toBeUndefined();
  });

  test("request の上書き後は最後の action だけ実行される", () => {
    const { request, confirm } = useClosePaneConfirm();
    const calls: string[] = [];
    request(() => calls.push("first"));
    request(() => calls.push("second"));
    confirm();
    expect(calls).toEqual(["second"]);
  });
});
