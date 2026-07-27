// 演出バーストの合流。実行中と同じ kind の再発火を畳む。
//
// gozd は複数 worktree で並列にエージェントを走らせるため、done / needs-input /
// エラー通知は互いに独立した非同期経路から短時間に束で届く。合流しないと、音は
// oscillator が線形加算されて音圧が跳ね、フラッシュは onset の反復（発火間隔が
// 演出長を下回ると点滅）になり、単発の刺激を穏やかにした設計が最悪ケースで崩れる。
//
// kind が変わったときは新しい情報なので畳まず差し替える。

/** フラッシュを伴う演出の種別 */
export type FxKind = "warning" | "error" | "success";

export interface FxCoalescer {
  /** 発火してよければ true。実行中と同じ kind なら false（畳む） */
  accept(kind: FxKind): boolean;
  /** 実行中の演出が終わったことを通知する */
  finish(): void;
}

export function createFxCoalescer(): FxCoalescer {
  let activeKind: FxKind | undefined;

  return {
    accept(kind) {
      if (activeKind === kind) return false;
      activeKind = kind;
      return true;
    },
    finish() {
      activeKind = undefined;
    },
  };
}
