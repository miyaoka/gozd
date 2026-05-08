// Swift → renderer の push 経路のシングルトン dispatcher。
//
// `apps/native` の `WebPage.callJavaScript("window.__gozdReceive(type, payload)", ...)` を
// 受ける。type ごとの listener 配列を持ち、`onMessage(type, fn)` で購読、戻り値の
// disposer で解除する。
//
// 設計判断:
//
// 1. **payload 型は feature が定義する**。shared は payload 形を知らない。
//    呼び出し側が `onMessage<MyPayload>("my-type", fn)` の generic で型を当てる。
//    GozdMessageMap を持つと shared が feature 知識を持ってしまうため。
//
// 2. **window.__gozdReceive はシングルトン**。複数モジュールが上書きしないよう、
//    最初に import されたタイミングで dispatcher に固定する。

type AnyListener = (payload: unknown) => void;

const listeners = new Map<string, AnyListener[]>();

declare global {
  interface Window {
    __gozdReceive?: (type: string, payload: unknown) => void;
  }
}

window.__gozdReceive = (type, payload) => {
  const fns = listeners.get(type);
  if (fns === undefined) return;
  for (const fn of fns) fn(payload);
};

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
