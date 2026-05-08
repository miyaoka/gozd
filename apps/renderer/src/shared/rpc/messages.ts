// Swift → renderer の push 経路。
//
// apps/native の WebPage.callJavaScript("window.__gozdReceive(type, payload)", ...) を
// 受ける単一エントリポイント。type ごとに購読関数を提供し、disposer で解除する。
//
// 設計判断:
//
// 1. **proto を介さない素オブジェクト**。push の payload は apps/native 側で
//    `[String: Any]` を組み立てているため、renderer も素オブジェクトとして扱う。
//    将来 proto3 binary 化する余地は残すが、今は YAGNI
//
// 2. **window.__gozdReceive はシングルトン**。複数モジュールが上書きしないよう、
//    最初に import されたタイミングで dispatcher に固定する

interface PtyTextPayload {
  id: number;
  text: string;
}

interface PtyExitReason {
  kind: "exited" | "signaled" | "stopped";
  exitCode?: number;
  signal?: number;
  coreDumped?: boolean;
}

interface PtyExitPayload {
  id: number;
  reason: PtyExitReason;
}

interface HookPayload {
  event: string;
  ptyId: number;
  lastAssistantMessage: string;
  toolName: string;
  toolInput: string;
  isInterrupt: boolean;
}

interface OpenPayload {
  targetPath: string;
}

export interface GozdMessageMap {
  ptyText: PtyTextPayload;
  ptyExit: PtyExitPayload;
  hook: HookPayload;
  open: OpenPayload;
}

type Listener<K extends keyof GozdMessageMap> = (payload: GozdMessageMap[K]) => void;

const listeners: { [K in keyof GozdMessageMap]: Listener<K>[] } = {
  ptyText: [],
  ptyExit: [],
  hook: [],
  open: [],
};

declare global {
  interface Window {
    __gozdReceive?: (type: string, payload: unknown) => void;
  }
}

window.__gozdReceive = (type, payload) => {
  const fns = listeners[type as keyof GozdMessageMap];
  if (fns === undefined) {
    console.warn(`[gozd] unknown message type: ${type}`);
    return;
  }
  for (const fn of fns) (fn as Listener<keyof GozdMessageMap>)(payload as never);
};

export function onMessage<K extends keyof GozdMessageMap>(type: K, fn: Listener<K>): () => void {
  const arr = listeners[type];
  arr.push(fn);
  return () => {
    const idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  };
}
