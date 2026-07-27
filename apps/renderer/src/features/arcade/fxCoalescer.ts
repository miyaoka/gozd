// 演出バーストの合流。実行中の演出より優先度が高い発火だけを通す。
//
// gozd は複数 worktree で並列にエージェントを走らせるため、done / needs-input /
// エラー通知は互いに独立した非同期経路から短時間に束で届く。合流しないと、音は
// oscillator が線形加算されて音圧が跳ね、フラッシュは onset の反復（発火間隔が
// 演出長を下回ると点滅）になり、単発の刺激を穏やかにした設計が最悪ケースで崩れる。
//
// 判定を kind の同一性ではなく優先度に置くのは、束が同一 kind に揃う保証がないため。
// 「別 kind なら通す」にすると done と needs-input が交互に来る束（並列エージェントで
// 最も起きやすい形）が 1 件も畳まれず、色が変わるぶん同一 kind の反復より刺激が強くなる。
// 優先度置換なら 1 窓あたりの発火は昇順の高々 3 回に有界化される。
//
// 「実行中なら全部畳む」を採らないのは、done の直後に届いた stop-failure が捨てられ、
// 失敗した事実が成功の演出に覆い隠されるため。上位 kind は常に割り込めなければならない。
//
// 窓と効果の所有権をこのモジュールに置き、呼び出し側には kind の ref だけを見せる。
// 判断だけを切り出して効果の実行を呼び出し側に残すと、配線が壊れても単体テストは通る。

import { tryCatch } from "@gozd/shared";
import { ref, type Ref } from "vue";

/** フラッシュを伴う演出の種別 */
type FxKind = "warning" | "error" | "success";

/** 割り込みの優先度。実行中と同じかそれ以下の kind は畳む */
const FX_RANK: Record<FxKind, number> = {
  success: 0,
  warning: 1,
  error: 2,
};

export interface FxCoalescer {
  /** 実行中の演出の kind。演出が無ければ undefined */
  kind: Ref<FxKind | undefined>;
  /** 演出を要求する。畳まれた場合 effects は呼ばれない */
  run(kind: FxKind, effects: () => void): void;
  /** 予約中の解放タイマーを破棄する（unmount 用） */
  dispose(): void;
}

/** `windowMs` は演出 1 回の長さ。この間に届いた同格以下の発火を畳む */
export function createFxCoalescer(windowMs: number): FxCoalescer {
  const kind = ref<FxKind | undefined>(undefined);
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    kind,
    run(next, effects) {
      const active = kind.value;
      if (active !== undefined && FX_RANK[next] <= FX_RANK[active]) return;

      // 窓の確保と解放予約を effects より先に済ませる。effects が throw したときに
      // 解放が予約されていないと kind が latch し、以降その kind の演出が出なくなる
      kind.value = next;
      if (releaseTimer !== undefined) clearTimeout(releaseTimer);
      releaseTimer = setTimeout(() => {
        kind.value = undefined;
        releaseTimer = undefined;
      }, windowMs);

      const result = tryCatch(() => {
        effects();
      });
      if (!result.ok) {
        console.error(`[fxCoalescer] effects failed: ${result.error} kind=${next}`);
      }
    },
    dispose() {
      if (releaseTimer !== undefined) clearTimeout(releaseTimer);
      releaseTimer = undefined;
    },
  };
}
