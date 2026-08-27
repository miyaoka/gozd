// main → renderer の push 経路のシングルトン dispatcher。
//
// main process の `webContents.send("rpc:push", type, payload)` を preload の
// `__gozdElectronRpc.onPush` 経由で受ける。type ごとに listener を保持し、
// `onMessage(type, fn)` で購読、戻り値の disposer で解除する。
//
// 設計判断:
//
// 1. **onMessage は payload 形を知らない**。呼び出し側が `onMessage<MyPayload>("my-type", fn)`
//    の generic で型を当てる。ワイヤ push の payload 型は @gozd/rpc（`PushPayloadMap`）が
//    SSOT で送信側を閉じるが、このバスには renderer 内部イベント（fsWatchReady / claudeFx 等、
//    feature 所有の型）も乗るため、受信側をワイヤの map だけで閉じることはできない。
//
// 2. **`window` への登録は明示の `initRpcDispatcher()` で行う**。モジュールトップレベルで
//    `window.__gozdReceive = ...` を実行すると import するだけで window へ書き込む副作用が
//    生じ、bun:test / SSR / 非 DOM 環境でロードエラーになる。renderer の bootstrap
//    (`main.ts`) で 1 回だけ呼び出す契約にすることで、import 時の副作用を排除する。

import type { PushPayloadMap } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";

type AnyListener = (payload: unknown) => void;

// listener の集合は Set。反復中の delete は仕様上その場でスキップされるため、
// dispatch 中に disposer が呼ばれても配送コピーを取らずに済む（ptyText のように
// MB/s で流れる type があるので、dispatch 側の割り当てはゼロに保つ）。
// 解除も indexOf + splice の O(n) ではなく O(1) になる。
// 対になる保証として、反復中に追加された値は訪問される。dispatch 中に同じ type を
// 新規購読するとその listener は配送中の event も受け取る（EventTarget とは逆）。
// ハンドラ内から購読を足さないこと。
const listeners = new Map<string, Set<AnyListener>>();

/**
 * 届く購読者が居なかったときに観察ログを残す push の type。
 *
 * **mount 時の pull で取り直せる payload は載せない。** 大半の push は「mount で pull、
 * 変化で push」の契約（docs/architecture.md）に乗っており、購読者が居ない間の取りこぼしは
 * 設計どおりの捨て方で、失敗ではない。それらまで記録すると、renderer の再構築のたびに
 * 全 type ぶんのログが出て、本当に失われた 1 件が埋もれる。
 *
 * `newWorktree` の指示文は push payload にしか存在せず、落ちると worktree だけが残って
 * 指示は戻らない。同じ性質を持つ type は他にもあり（docs/rpc.md の購読契約）、この集合は
 * それらを網羅していない。足すときは pull の相手が無いことを確かめてから足す。
 */
const UNRECOVERABLE_PUSH_TYPES = new Set<keyof PushPayloadMap>(["newWorktree"]);

/**
 * listener の失敗の追加報告先。feature 層から `setListenerErrorReporter()` で注入する。
 * shared 間の依存禁止 + shared → feature 依存禁止のため、報告先を直接呼べない
 * (`useCommandRegistry` の `setErrorHandler` と同じ DI 流儀)。
 * `undefined` を渡せばリセットする（module singleton をテスト間で初期化するため）。
 */
let listenerErrorReporter: ((type: string, cause: unknown) => void) | undefined;

export function setListenerErrorReporter(
  reporter: ((type: string, cause: unknown) => void) | undefined,
): void {
  listenerErrorReporter = reporter;
}

/**
 * 届く購読者が居なかった push の追加報告先。listener の失敗とは原因が別なので報告先も
 * 分ける（event-log の行が「購読者側のバグ」と「購読が張られていなかった」を撃ち分ける）。
 */
let undeliveredReporter: ((type: string) => void) | undefined;

export function setUndeliveredReporter(reporter: ((type: string) => void) | undefined): void {
  undeliveredReporter = reporter;
}

/**
 * console の floor + 注入先への報告の二段構え（main 側 `makeDebugLogPush` と同型）。
 * floor を注入の有無に関わらず出すのは、bridge 注入前に届いた push と、報告先の実装が
 * console を書き忘れた場合の両方で観測が消えないようにするため。書式を 1 箇所に閉じる
 * 意味もある（tag は発火元のこのモジュールの名前でなければならない）。
 */
function reportListenerError(type: string, cause: unknown): void {
  // error はテンプレート補間せず第 2 引数で渡す。この経路の失敗は listener 側の
  // プログラミングエラーで、発生箇所を特定できる材料は stack だけになる
  console.error(`[dispatchToListeners] listener failed type=${type}`, cause);

  // reporter も注入された実装なので listener と同じ規律で隔離する。ここで throw すると
  // 残りの listener がその event を落とし、隔離の不変条件が報告経路から破れる。
  // 元の失敗は上の floor で記録済みなので握り潰しにはならない
  const result = tryCatch(() => {
    listenerErrorReporter?.(type, cause);
  });
  if (!result.ok) {
    console.error(`[dispatchToListeners] reporter failed type=${type}`, result.error);
  }
}

/**
 * 誰にも届かなかった push を記録する。listener の throw（`reportListenerError`）とは
 * 原因が違う — あちらは購読者側のバグ、こちらは購読が張られる前 / 外れた後に届いたこと。
 * 報告先も同じ二段構え（console floor + 注入先）にする。
 */
function reportUndelivered(type: string): void {
  console.error(`[dispatchToListeners] no listener received type=${type}; payload dropped`);
  const result = tryCatch(() => {
    undeliveredReporter?.(type);
  });
  if (!result.ok) {
    console.error(`[dispatchToListeners] undelivered reporter failed type=${type}`, result.error);
  }
}

function dispatchToListeners(type: string, payload: unknown): void {
  const fns = listeners.get(type);
  // size 0 は「購読が全部外れた後」。undefined（一度も購読されていない）と区別しない
  if (fns === undefined || fns.size === 0) {
    if ((UNRECOVERABLE_PUSH_TYPES as ReadonlySet<string>).has(type)) reportUndelivered(type);
    return;
  }
  // listener ごとに隔離する。1 つの throw で登録順の後続が同じ event を丸ごと落とすと、
  // 互いに無関係な購読者どうしで状態が黙ってずれる（claudeFx は arcade と voicevox が
  // 独立に購読しており、片方の失敗がもう片方を飢えさせる理由はない）。
  for (const fn of fns) {
    const result = tryCatch(() => {
      fn(payload);
    });
    if (!result.ok) reportListenerError(type, result.error);
  }
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
  const set = listeners.get(type) ?? new Set<AnyListener>();
  set.add(fn as AnyListener);
  listeners.set(type, set);
  return () => {
    listeners.get(type)?.delete(fn as AnyListener);
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
