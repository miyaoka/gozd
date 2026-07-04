// main → renderer の push 経路のシングルトン dispatcher。
//
// main process の `webContents.send("rpc:push", type, payload)` を preload の
// `__gozdElectronRpc.onPush` 経由で受ける。type ごとの listener 配列を持ち、
// `onMessage(type, fn)` で購読、戻り値の disposer で解除する。
//
// 設計判断:
//
// 1. **payload 型は feature が定義する**。shared は payload 形を知らない。
//    呼び出し側が `onMessage<MyPayload>("my-type", fn)` の generic で型を当てる。
//    GozdMessageMap を持つと shared が feature 知識を持ってしまうため。
//
// 2. **`window` への登録は明示の `initRpcDispatcher()` で行う**。モジュールトップレベルで
//    `window.__gozdReceive = ...` を実行すると import するだけで window へ書き込む副作用が
//    生じ、bun:test / SSR / 非 DOM 環境でロードエラーになる。renderer の bootstrap
//    (`main.ts`) で 1 回だけ呼び出す契約にすることで、import 時の副作用を排除する。

type AnyListener = (payload: unknown) => void;

const listeners = new Map<string, AnyListener[]>();

function dispatchToListeners(type: string, payload: unknown): void {
  const fns = listeners.get(type);
  if (fns === undefined) return;
  for (const fn of fns) fn(payload);
}

/**
 * renderer bootstrap で 1 回だけ呼ぶ。preload が公開する `__gozdElectronRpc.onPush` を
 * dispatcher に接続する（contextIsolation 下の preload は main world の関数を直接
 * 呼べないため、購読登録は renderer 側の責務になる）。
 *
 * test / SSR では呼ばない契約。listener 登録 (`onMessage`) や renderer 内部の
 * 再同期 push (`dispatchMessage`) は init 不要で動く (どちらも `dispatchToListeners`
 * を直接呼ぶため、window indirection が無くて済む)。
 */
export function initRpcDispatcher(): void {
  window.__gozdElectronRpc?.onPush(dispatchToListeners);
}

export function onMessage<T>(type: string, fn: (payload: T) => void): () => void {
  const arr = listeners.get(type) ?? [];
  arr.push(fn as AnyListener);
  listeners.set(type, arr);
  return () => {
    const cur = listeners.get(type);
    if (cur === undefined) return;
    const idx = cur.indexOf(fn as AnyListener);
    if (idx >= 0) cur.splice(idx, 1);
  };
}

/**
 * renderer 内部発の push を同じ dispatcher 経由で発火する。
 *
 * 通常 push は main → renderer の一方向（`rpc:push` 経由）だが、
 * renderer 内で「watch 開始後の取りこぼし救済」「明示的な再同期トリガー」など
 * main 経由ではない再同期 event が必要なケースで使う。listener 側は
 * `onMessage` と同じ subscriber を再利用できる（main 由来と renderer 由来を
 * 区別せず処理する）。
 *
 * 命名は `dispatchMessage` で、main の push と意味的に並ぶ位置に置く。
 * 実装は `dispatchToListeners` 直呼び出し: window 経由を挟まないため、
 * `initRpcDispatcher` を呼んでいない test 環境からも動く。
 */
export function dispatchMessage(type: string, payload: unknown): void {
  dispatchToListeners(type, payload);
}
